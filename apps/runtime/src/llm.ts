import { buildSystemPrompt } from "./prompt.js";
import { formatRuntimeState } from "./conversation.js";
import { applyLpPickFromText, bypassLlm, cancelPendingTrade, fillAllAmount, formatToolReply, isUserRestart, parseBuySell, parseLocalCommand, rememberSwapQuote, runLocalCommand } from "./localCommands.js";
import { refreshHireFromTermix, serviceFeeLabel } from "./hire.js";
import { runTool, TOOL_DEFS, type ToolCtx } from "./tools.js";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content?: string; tool_call_id?: string; tool_calls?: any[] };

function preferZh(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

export async function runAgentTurn(userText: string, ctx: ToolCtx, env: { llmBase: string; llmKey: string; llmModel: string }): Promise<string> {
  if (ctx.termix) {
    try {
      await refreshHireFromTermix(ctx);
    } catch {
      /* keep local slots */
    }
  }
  const cmd = parseLocalCommand(userText);
  if (cmd.kind === "cancel") {
    const reply = cancelPendingTrade(ctx);
    recordTurns(ctx, userText, reply);
    return reply;
  }

  if (isUserRestart(userText)) {
    cancelPendingTrade(ctx);
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);
  }

  const fromPick = await applyLpPickFromText(ctx, userText);
  if (fromPick) {
    const reply = formatToolReply(fromPick, { zh: preferZh(userText) });
    recordTurns(ctx, userText, reply);
    return reply;
  }

  const remembered = parseBuySell(userText);
  if (remembered) {
    try {
      rememberSwapQuote(ctx, await fillAllAmount(ctx, remembered));
    } catch (err) {
      const reply = err instanceof Error ? err.message : String(err);
      recordTurns(ctx, userText, reply);
      return reply;
    }
  }

  if (!env.llmKey) {
    return await fallbackWithoutLlm(userText, ctx);
  }

  if (cmd.kind === "quote" && cmd.amountInUi.toLowerCase() === "all") {
    const reply = await executeConfirm(userText, ctx);
    recordTurns(ctx, userText, reply);
    return reply;
  }

  if (bypassLlm(cmd.kind, true)) {
    if (cmd.kind === "confirm" || cmd.kind === "proceed") {
      ctx.conversation.userConfirmed = true;
      ctx.conversations.save(ctx.conversation);
    }
    const reply = await executeConfirm(userText, ctx);
    recordTurns(ctx, userText, reply);
    return reply;
  }

  if (cmd.kind === "lp" && !cmd.amountTokenUi && !cmd.amountQuoteUi && !cmd.budgetQuoteUi && !cmd.pick && !/分析|analyze/i.test(userText)) {
    const raw = await runLocalCommand(userText, ctx);
    const reply = raw ? formatToolReply(raw, { zh: preferZh(userText) }) : await executeConfirm(userText, ctx);
    recordTurns(ctx, userText, reply);
    return reply;
  }

  const prior = (ctx.conversation.turns ?? []).map((t) => ({
    role: t.role,
    content: t.content,
  }));
  const messages: ChatMsg[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "system", content: formatRuntimeState(ctx.conversation) },
  ];
  if (cmd.kind !== "none") {
    messages.push({
      role: "system",
      content: [
        `Parser hint (suggestion only): ${JSON.stringify(cmd)}.`,
        "If it matches the user's sentence, call the corresponding tool.",
        "The full user sentence wins if they conflict. Follow-ups like 改成一半 / 换成 USDT / 再报一次 replace the pending plan.",
        "Never dump tool JSON. Reply in the user's language with amounts, pool, risks, and the next step.",
      ].join(" "),
    });
  }
  messages.push(...prior, { role: "user", content: userText });

  try {
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${env.llmBase.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.llmKey}`,
        },
        body: JSON.stringify({
          model: env.llmModel,
          messages,
          tools: TOOL_DEFS,
          temperature: 0.2,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`LLM ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        choices: Array<{ message: ChatMsg; finish_reason?: string }>;
      };
      const msg = json.choices[0]?.message;
      if (!msg) throw new Error("empty LLM response");
      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const call of msg.tool_calls) {
          const name = call.function?.name as string;
          const argStr = call.function?.arguments ?? "{}";
          let result: string;
          try {
            result = await runTool(name, argStr, ctx);
          } catch (err) {
            result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }
      const reply = msg.content?.trim() || "(empty reply)";
      const spoken = /^[\[{]/.test(reply) ? formatToolReply(reply, { zh: preferZh(userText) }) : reply;
      recordTurns(ctx, userText, spoken);
      return spoken;
    }
    return "Too many tool calls this turn. Please send another message.";
  } catch (err) {
    if (cmd.kind !== "none") {
      try {
        const handled = await runLocalCommand(userText, ctx);
        if (handled) {
          const reply = formatToolReply(handled, { zh: preferZh(userText) });
          recordTurns(ctx, userText, reply);
          return reply;
        }
      } catch {
        /* fall through to LLM error */
      }
    }
    throw err;
  }
}

async function executeConfirm(userText: string, ctx: ToolCtx): Promise<string> {
  if (!ctx.conversation.geoConfirmed) {
    return [
      "单独回「确认」是执行报价，不是过地区门槛。",
      "请完整回复：我确认不在美国及受限地区",
      'or: I confirm I am not in the United States or a restricted region',
    ].join("\n");
  }
  try {
    const handled = await runLocalCommand(userText, ctx);
    if (handled) return formatToolReply(handled, { zh: preferZh(userText) });
    const phase = ctx.conversation.hirePhase ?? "none";
    if (ctx.conversation.source === "termix" && (phase === "none" || phase === "quoting")) {
      return formatToolReply(await runTool("send_termix_offer", "{}", ctx), { zh: preferZh(userText) });
    }
    if (ctx.conversation.source === "termix" && phase === "offered") {
      return `The ${serviceFeeLabel()} offer is already out. Accept that card and finish Termix checkout. I will accept the order after it is funded.`;
    }
    if (ctx.conversation.source === "termix" && phase === "funded") {
      return formatToolReply(await runTool("provider_accept_order", "{}", ctx), { zh: preferZh(userText) });
    }
    return "没有待执行的报价。直接说要做什么，例如：用 100 USDT 买英伟达 / 用全部 NVDAB 组 USDT 1% 池。";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function recordTurns(ctx: ToolCtx, userText: string, reply: string) {
  ctx.conversations.appendTurn(ctx.conversation.id, "user", userText);
  ctx.conversations.appendTurn(ctx.conversation.id, "assistant", reply);
  ctx.conversation.turns = ctx.conversations.get(ctx.conversation.id).turns;
}

async function fallbackWithoutLlm(userText: string, ctx: ToolCtx): Promise<string> {
  if (!ctx.conversation.geoConfirmed) {
    return [
      "Hi, I'm bStocks Agent (not investment advice).",
      "Before we start, confirm you are not in the United States or any restricted region, and that you understand bStocks are certificate-style exposure, not direct equity.",
      'Reply: "I confirm I am not in the United States or a restricted region" or 「我确认不在美国及受限地区」.',
    ].join("\n");
  }
  if (!ctx.conversation.wallet) {
    return "Geo declaration recorded. Send your BSC wallet address (0x…). I can quote after that, but I will not create a trade before you confirm.";
  }
  if (isUserRestart(userText)) {
    cancelPendingTrade(ctx);
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);
  }
  try {
    const handled = await runLocalCommand(userText, ctx);
    if (handled) return formatToolReply(handled, { zh: preferZh(userText) });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return [
    "Local rule replies (quotes and intents still work without DEEPSEEK_API_KEY).",
    `Wallet ${ctx.conversation.wallet}. geo=${ctx.conversation.geoConfirmed}, confirm=${ctx.conversation.userConfirmed}.`,
    "Examples: quote USDT→NVDAB 10 ; NVIDIA highest apr ; add 100u to the best pool ; addLP NVDAB 0.01 ; my positions ; confirm.",
    `You said: ${userText.slice(0, 200)}`,
  ].join("\n");
}
