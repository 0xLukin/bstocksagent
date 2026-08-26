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
import { runTool, TOOL_DEFS, type ToolCtx } from "./tools.js";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content?: string; tool_call_id?: string; tool_calls?: any[] };

export async function runAgentTurn(userText: string, ctx: ToolCtx, env: { llmBase: string; llmKey: string; llmModel: string }): Promise<string> {
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
    localKind === "lp-compare"
  ) {
    const handled = await runLocalCommand(userText, ctx);
    const reply = formatToolReply(handled ?? "做不到这一步。");
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
    const reply = msg.content?.trim() || "（空回复）";
    recordTurns(ctx, userText, reply);
    return reply;
  }
  return "本轮工具调用次数过多，已停止。请用户再发一条消息。";
}

async function executeConfirm(userText: string, ctx: ToolCtx): Promise<string> {
  try {
    const handled = await runLocalCommand(userText, ctx);
    return formatToolReply(handled ?? "还没有待确认的报价。请再说一次要买/卖的标的和金额，例如：用 100 USDT 买英伟达。");
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
      "你好，我是 bstocks-yield（非投资建议）。",
      "使用前请先声明：你不在美国及任何受限地区，并理解 bStocks 是证书类敞口、不是直接持股。",
      "请回复：「我确认不在美国及受限地区」。",
    ].join("\n");
  }
  if (!ctx.conversation.wallet) {
    return "地理声明已记录。请发送你的 BSC 钱包地址（0x…）。之后我可以报价，但不会在你确认前创建交易。";
  }
  try {
    const handled = await runLocalCommand(userText, ctx);
    if (handled) return formatToolReply(handled);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return [
    "当前为本地规则回复（未配置 DEEPSEEK_API_KEY 也可跑通报价/出意图）。",
    `已记录钱包 ${ctx.conversation.wallet}。地理确认=${ctx.conversation.geoConfirmed}，执行确认=${ctx.conversation.userConfirmed}。`,
    "例句：报价 USDT→NVDAB 10 ；英伟达最高apr ；加 100u 那个最高的 ；加LP NVDAB 0.01 ；我的仓位 ；确认执行。",
    `你刚才说：${userText.slice(0, 200)}`,
  ].join("\n");
}
