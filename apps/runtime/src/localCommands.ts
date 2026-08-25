import { runTool, type ToolCtx } from "./tools.js";

export type LocalCmd =
  | { kind: "quote"; tokenIn: string; tokenOut: string; amountInUi: string }
  | { kind: "price"; token: string; quote: string }
  | { kind: "lp"; token: string; amountTokenUi?: string; amountQuoteUi?: string }
  | { kind: "confirm" }
  | { kind: "none" };

const PAIR = /(?:报价|quote)\s+([A-Za-z0-9]+)\s*(?:→|->|=>|to|换|兑)?\s*([A-Za-z0-9]+)\s+([\d.]+)/i;
const PRICE = /(?:价格|price)\s+([A-Za-z0-9]+)(?:\s*\/\s*([A-Za-z0-9]+))?/i;
const LP = /(?:加lp|加池|analyze[_\s-]?lp|分析)\s+([A-Za-z0-9]+)(?:\s+([\d.]+))?(?:\s+([\d.]+))?/i;

export function parseLocalCommand(text: string): LocalCmd {
  const t = text.trim();
  if (/^(确认|同意|确认执行|confirm|proceed)$/i.test(t) || /确认(本次|以上|这笔|swap|lp|交易)/i.test(t)) {
    return { kind: "confirm" };
  }
  const quote = t.match(PAIR);
  if (quote) {
    return { kind: "quote", tokenIn: quote[1]!, tokenOut: quote[2]!, amountInUi: quote[3]! };
  }
  const price = t.match(PRICE);
  if (price) {
    return { kind: "price", token: price[1]!, quote: price[2] ?? "USDT" };
  }
  const lp = t.match(LP);
  if (lp) {
    return { kind: "lp", token: lp[1]!, amountTokenUi: lp[2], amountQuoteUi: lp[3] };
  }
  return { kind: "none" };
}

export async function runLocalCommand(text: string, ctx: ToolCtx): Promise<string | null> {
  const cmd = parseLocalCommand(text);
  if (cmd.kind === "none") return null;

  if (cmd.kind === "price") {
    return runTool("get_bstock_price", JSON.stringify({ token: cmd.token, quote: cmd.quote }), ctx);
  }

  if (cmd.kind === "quote") {
    ctx.conversation.lastQuote = {
      tokenIn: cmd.tokenIn,
      tokenOut: cmd.tokenOut,
      amountInUi: cmd.amountInUi,
    };
    ctx.conversations.save(ctx.conversation);
    const quoted = await runTool(
      "quote_swap",
      JSON.stringify({ tokenIn: cmd.tokenIn, tokenOut: cmd.tokenOut, amountInUi: cmd.amountInUi }),
      ctx,
    );
    return [
      quoted,
      "",
      "这是只读报价，不构成投资建议。核对 raw / UI 后回复「确认执行」才会生成签名页链接。",
    ].join("\n");
  }

  if (cmd.kind === "lp") {
    ctx.conversation.lastLp = {
      token: cmd.token,
      amountTokenUi: cmd.amountTokenUi,
      amountQuoteUi: cmd.amountQuoteUi,
    };
    ctx.conversations.save(ctx.conversation);
    const analysis = await runTool("analyze_lp", JSON.stringify({ token: cmd.token }), ctx);
    if (!cmd.amountTokenUi) {
      return [analysis, "", "若要加池，发送：加LP NVDAB 0.01 ，再回复「确认执行」。"].join("\n");
    }
    return [analysis, "", "核对区间与风险后回复「确认执行」，才会生成加 LP 签名页。"].join("\n");
  }

  const pending = ctx.conversation.lastLp?.amountTokenUi
    ? { type: "lp" as const, ...ctx.conversation.lastLp }
    : ctx.conversation.lastQuote
      ? { type: "swap" as const, ...ctx.conversation.lastQuote }
      : null;
  if (!pending) {
    return "还没有待确认的报价。先发送：报价 USDT→NVDAB 10 或 加LP NVDAB 0.01";
  }
  if (pending.type === "swap") {
    return runTool(
      "create_swap_intent",
      JSON.stringify({
        tokenIn: pending.tokenIn,
        tokenOut: pending.tokenOut,
        amountInUi: pending.amountInUi,
      }),
      ctx,
    );
  }
  return runTool(
    "create_lp_intent",
    JSON.stringify({
      token: pending.token,
      amountTokenUi: pending.amountTokenUi,
      amountQuoteUi: pending.amountQuoteUi,
    }),
    ctx,
  );
}
