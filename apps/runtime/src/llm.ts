import { SYSTEM_PROMPT } from "./prompt.js";
import { runTool, TOOL_DEFS, type ToolCtx } from "./tools.js";

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content?: string; tool_call_id?: string; tool_calls?: any[] };

export async function runAgentTurn(userText: string, ctx: ToolCtx, env: { llmBase: string; llmKey: string; llmModel: string }): Promise<string> {
  if (!env.llmKey) {
    return fallbackWithoutLlm(userText, ctx);
  }

  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `当前对话状态：${JSON.stringify({
        geoConfirmed: ctx.conversation.geoConfirmed,
        userConfirmed: ctx.conversation.userConfirmed,
        wallet: ctx.conversation.wallet,
        lastOrderId: ctx.conversation.lastOrderId,
      })}`,
    },
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
    return msg.content?.trim() || "（空回复）";
  }
  return "本轮工具调用次数过多，已停止。请用户再发一条消息。";
}

function fallbackWithoutLlm(userText: string, ctx: ToolCtx): string {
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
  return [
    "本地未配置 OPENROUTER_API_KEY / OPENAI_API_KEY，当前为规则回复。",
    `已记录钱包 ${ctx.conversation.wallet}。地理确认=${ctx.conversation.geoConfirmed}，执行确认=${ctx.conversation.userConfirmed}。`,
    "你可以说：报价 USDT→NVDAB 10；或确认执行。配置 LLM 后将自动调用工具。",
    `你刚才说：${userText.slice(0, 200)}`,
  ].join("\n");
}
