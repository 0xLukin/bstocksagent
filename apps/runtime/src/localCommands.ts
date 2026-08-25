import { getToken } from "@bstocks/chain";
import type { PendingQuote } from "./conversation.js";
import { runTool, type ToolCtx } from "./tools.js";

export type LocalCmd =
  | { kind: "quote"; tokenIn: string; tokenOut: string; amountInUi: string }
  | { kind: "price"; token: string; quote: string }
  | { kind: "lp"; token: string; amountTokenUi?: string; amountQuoteUi?: string }
  | { kind: "confirm" }
  | { kind: "none" };

const TOK = "[A-Za-z0-9\\u4e00-\\u9fff]+";
const PAIR = new RegExp(
  `(?:报价|quote)\\s+(${TOK})\\s*(?:→|->|=>|to|换|兑)?\\s*(${TOK})\\s+([\\d.]+)`,
  "i",
);
const PRICE = new RegExp(`(?:价格|price)\\s+(${TOK})(?:\\s*/\\s*(${TOK}))?`, "i");
const PRICE_LOOSE = new RegExp(
  `(?:查看|查一下|看看|查下)?\\s*([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:的)?(?:报价|价格|行情)`,
  "i",
);
const LP = new RegExp(
  `(?:加lp|加池|analyze[_\\s-]?lp|分析)\\s+(${TOK})(?:\\s+([\\d.]+))?(?:\\s+([\\d.]+))?`,
  "i",
);

export function parseBuySell(text: string): PendingQuote | null {
  const t = text.trim();
  const spend = t.match(
    new RegExp(
      `(?:用)?\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd)\\s*(?:买|买入|要买|购入|换|兑)\\s*(?:成|到|得|的)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (spend) {
    return { tokenIn: "USDT", tokenOut: spend[3]!, amountInUi: spend[1]! };
  }
  const buy = t.match(
    new RegExp(`(?:买|买入|要买|购入)\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd)\\s*(?:的|得)?\\s*(${TOK})`, "i"),
  );
  if (buy) {
    return { tokenIn: "USDT", tokenOut: buy[3]!, amountInUi: buy[1]! };
  }
  const sell = t.match(
    new RegExp(`(?:卖|卖出)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:个|股)?\\s*(?:的)?\\s*(${TOK})(?:\\s*(?:换|成|得)\\s*(u|usdt|usd))?`, "i"),
  );
  if (sell) {
    return { tokenIn: sell[2]!, tokenOut: "USDT", amountInUi: sell[1]! };
  }
  return null;
}

export function rememberSwapQuote(ctx: ToolCtx, quote: PendingQuote) {
  ctx.conversation.lastQuote = {
    tokenIn: canonSymbol(quote.tokenIn),
    tokenOut: canonSymbol(quote.tokenOut),
    amountInUi: quote.amountInUi,
  };
  delete ctx.conversation.lastLp;
  ctx.conversations.save(ctx.conversation);
}

function canonSymbol(symbol: string): string {
  try {
    return getToken(symbol).symbol;
  } catch {
    return symbol.trim().toUpperCase();
  }
}

export function formatToolReply(raw: string): string {
  try {
    const data = JSON.parse(raw) as {
      signerUrl?: string;
      error?: string;
      blockers?: string[];
      summary?: { tokenIn?: string; tokenOut?: string; amountInUi?: string; amountOutUi?: string };
    };
    if (data.error === "risk_blocked") {
      return ["风控未通过，没有生成签名页。", ...(data.blockers ?? [])].join("\n");
    }
    if (data.signerUrl) {
      const s = data.summary ?? {};
      const pair =
        s.tokenIn && s.tokenOut ? `${s.amountInUi ?? ""} ${s.tokenIn} → 约 ${s.amountOutUi ?? "?"} ${s.tokenOut}` : "";
      return [
        "已按你上一笔确认的报价生成待签意图（不是投资建议）。",
        pair.trim(),
        `签名页：${data.signerUrl}`,
        "请用绑定钱包核对地址、滑点和 raw 后再签名。过期需重新报价。",
      ]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    /* plain text */
  }
  return raw;
}

export function parseLocalCommand(text: string): LocalCmd {
  const t = text.trim();
  if (/^(确认|同意|确认执行|confirm|proceed)$/i.test(t) || /确认(本次|以上|这笔|swap|lp|交易)/i.test(t)) {
    return { kind: "confirm" };
  }
  const quote = t.match(PAIR);
  if (quote) {
    return { kind: "quote", tokenIn: quote[1]!, tokenOut: quote[2]!, amountInUi: quote[3]! };
  }
  const price = t.match(PRICE) ?? t.match(PRICE_LOOSE);
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
    rememberSwapQuote(ctx, {
      tokenIn: cmd.tokenIn,
      tokenOut: cmd.tokenOut,
      amountInUi: cmd.amountInUi,
    });
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
