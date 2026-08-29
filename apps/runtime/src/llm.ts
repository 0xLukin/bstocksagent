import { buildSystemPrompt } from "./prompt.js";
import { formatRuntimeState } from "./conversation.js";
import {
  cancelPendingTrade,
  formatToolReply,
  parseBuySell,
  parseLocalCommand,
  rememberSwapQuote,
  runLocalCommand,
} from "./localCommands.js";
import { refreshHireFromTermix, serviceFeeLabel } from "./hire.js";
import { runTool, TOOL_DEFS, type ToolCtx } from "./tools.js";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content?: string; tool_call_id?: string; tool_calls?: any[] };

export async function runAgentTurn(userText: string, ctx: ToolCtx, env: { llmBase: string; llmKey: string; llmModel: string }): Promise<string> {
  if (ctx.termix) {
    try {
      await refreshHireFromTermix(ctx);
    } catch {
      /* keep local slots */
    }
  }
  const localKind = parseLocalCommand(userText).kind;
  if (localKind === "cancel") {
    const reply = cancelPendingTrade(ctx);
    recordTurns(ctx, userText, reply);
    return reply;
  }
  if (
    localKind === "positions" ||
    localKind === "collect" ||
    localKind === "decrease" ||
    localKind === "lp" ||
    localKind === "lp-compare" ||
    localKind === "quote" ||
    localKind === "price" ||
    localKind === "hire-offer" ||
    localKind === "deliver"
  ) {
    const handled = await runLocalCommand(userText, ctx);
    const reply = formatToolReply(handled ?? "I can't do that step.");
    recordTurns(ctx, userText, reply);
    return reply;
  }

  const remembered = parseBuySell(userText);
  if (remembered) rememberSwapQuote(ctx, remembered);

  if (!env.llmKey) {
    return await fallbackWithoutLlm(userText, ctx);
  }

  if (parseLocalCommand(userText).kind === "confirm") {
    const reply = await executeConfirm(userText, ctx);
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
    ...prior,
    { role: "user", content: userText },
  ];

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
    recordTurns(ctx, userText, reply);
    return reply;
  }
  return "Too many tool calls this turn. Please send another message.";
}

async function executeConfirm(userText: string, ctx: ToolCtx): Promise<string> {
  try {
    const handled = await runLocalCommand(userText, ctx);
    if (handled) return formatToolReply(handled);
    const phase = ctx.conversation.hirePhase ?? "none";
    if (ctx.conversation.source === "termix" && (phase === "none" || phase === "quoting")) {
      return formatToolReply(await runTool("send_termix_offer", "{}", ctx));
    }
    if (ctx.conversation.source === "termix" && phase === "offered") {
      return `The ${serviceFeeLabel()} offer is already out. Accept that card and finish Termix checkout. I will accept the order after it is funded.`;
    }
    if (ctx.conversation.source === "termix" && phase === "funded") {
      return formatToolReply(await runTool("provider_accept_order", "{}", ctx));
    }
    return "No pending quote. Restate the token and amount, e.g. buy 100 USDT of NVDAB / 用 100 USDT 买英伟达.";
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
  try {
    const handled = await runLocalCommand(userText, ctx);
    if (handled) return formatToolReply(handled);
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
