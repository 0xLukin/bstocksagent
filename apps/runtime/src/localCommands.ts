import { DEFAULT_LP_RANGE_BPS, getToken } from "@bstocks/chain";
import { isUserCancel, isUserConfirm } from "@bstocks/risk";
import type { PendingLp, PendingQuote } from "./conversation.js";
import { runTool, type ToolCtx } from "./tools.js";

export type LocalCmd =
  | { kind: "quote"; tokenIn: string; tokenOut: string; amountInUi: string }
  | { kind: "price"; token: string; quote: string }
  | { kind: "lp"; token: string; amountTokenUi?: string; amountQuoteUi?: string; budgetQuoteUi?: string }
  | { kind: "positions" }
  | { kind: "collect"; tokenId?: string }
  | { kind: "decrease"; fractionBps: number }
  | { kind: "confirm" }
  | { kind: "cancel" }
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
const COLLECT = /^(?:收(?:取)?(?:手续)?费|harvest|collect)(?:\s*#?\s*(\d+))?$/i;
const POSITIONS = /^(?:我的)?(?:仓位|持仓|positions?)$/i;
const DECREASE_FULL = /^(全撤|撤出全部|全部撤出|撤出)$/;
const DECREASE_HALF = /^(撤一半|减仓一半|撤 50%)$/;

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

export function rememberLp(ctx: ToolCtx, lp: PendingLp) {
  ctx.conversation.lastLp = {
    ...lp,
    token: canonSymbol(lp.token),
    rangeBps: lp.rangeBps ?? DEFAULT_LP_RANGE_BPS,
  };
  delete ctx.conversation.lastQuote;
  ctx.conversations.save(ctx.conversation);
}

function stripLpSuffix(token: string): string {
  return token.replace(/(?:的)?(?:lp|加池|池子?|流动性)$/i, "").trim();
}

export function parseAddLp(text: string): PendingLp | null {
  const t = text.trim();
  const budgetThenToken = t.match(
    new RegExp(
      `(?:帮我|请|想要?)?加\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd)\\s*(?:的)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (budgetThenToken) {
    return { token: stripLpSuffix(budgetThenToken[3]!), budgetQuoteUi: budgetThenToken[1]! };
  }
  const spendThenToken = t.match(
    new RegExp(
      `(?:用|把)\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd)\\s*(?:去|来|拿去)?\\s*加\\s*(?:成)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (spendThenToken) {
    return { token: stripLpSuffix(spendThenToken[3]!), budgetQuoteUi: spendThenToken[1]! };
  }
  const tokenThenBudget = t.match(
    new RegExp(
      `(?:加lp|加池|加)\\s*(${TOK})\\s*(?:lp|池|流动性)?\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd)`,
      "i",
    ),
  );
  if (tokenThenBudget) {
    return { token: stripLpSuffix(tokenThenBudget[1]!), budgetQuoteUi: tokenThenBudget[2]! };
  }
  return null;
}

function hasMintSize(lp?: PendingLp): boolean {
  return Boolean(lp && (lp.amountTokenUi || lp.amountQuoteUi || lp.budgetQuoteUi));
}

export function formatToolReply(raw: string): string {
  try {
    const data = JSON.parse(raw) as {
      signerUrl?: string;
      error?: string;
      message?: string;
      blockers?: string[];
      display?: string;
      uiPrice?: string;
      token?: string;
      quote?: string;
      positions?: Array<{
        tokenId: string;
        token0: string;
        token1: string;
        fee: number;
        inRange: boolean;
        amount0Ui: string;
        amount1Ui: string;
        markUsd: string;
        feesUsdApprox: string;
        priceLower: string;
        priceUpper: string;
      }>;
      count?: number;
      summary?: {
        tokenIn?: string;
        tokenOut?: string;
        amountInUi?: string;
        amountOutUi?: string;
        token0?: string;
        token1?: string;
        amount0Ui?: string;
        amount1Ui?: string;
        rangePrices?: string;
        rangeLabel?: string;
        tokenId?: string;
      };
    };
    if (data.error === "risk_blocked") {
      return ["风控未通过，没有生成签名页。", ...(data.blockers ?? [])].join("\n");
    }
    if (data.error === "insufficient_balance") {
      return data.message ?? "余额不足。";
    }
    if (data.display && data.uiPrice) {
      return [
        data.display,
        "这是池内中间价（1 股值多少报价资产），不是投资建议。",
        "要下单请说金额，例如：用 100 USDT 买英伟达。",
      ].join("\n");
    }
    if (Array.isArray(data.positions)) {
      if (!data.positions.length) {
        return "绑定钱包下没有白名单 bStock 的 V3 仓位。可以说「加LP NVDAB 0.01」开一个（默认 ±30%）。";
      }
      const lines = data.positions.map((p) => {
        const range = p.inRange ? "区间内" : "已脱区间，不再吃手续费";
        return [
          `#${p.tokenId} ${p.token0}/${p.token1} ${(p.fee / 10000).toFixed(2)}% · ${range}`,
          `敞口 ${p.amount0Ui} ${p.token0} + ${p.amount1Ui} ${p.token1} · 标记约 $${p.markUsd}`,
          `未收约 $${p.feesUsdApprox} · 区间 ${p.priceLower}–${p.priceUpper}`,
        ].join("\n");
      });
      return [
        `仓位 ${data.count ?? data.positions.length} 条（不是收益承诺）：`,
        ...lines,
        "收割说「收手续费」，退出说「全撤」或「撤一半」，再回复「确认」。",
      ].join("\n\n");
    }
    if (data.signerUrl) {
      const s = data.summary ?? {};
      const pair =
        s.tokenIn && s.tokenOut
          ? `${s.amountInUi ?? ""} ${s.tokenIn} → 约 ${s.amountOutUi ?? "?"} ${s.tokenOut}`
          : s.token0 && s.token1
            ? `${s.amount0Ui ?? ""} ${s.token0} + ${s.amount1Ui ?? ""} ${s.token1}${s.rangeLabel ? ` · ${s.rangeLabel}` : ""}${s.rangePrices ? ` · ${s.rangePrices}` : ""}${s.tokenId ? ` · #${s.tokenId}` : ""}`
            : "";
      return [
        "已按你上一笔确认的方案生成待签意图（不是投资建议）。",
        pair.trim(),
        `签名页：${data.signerUrl}`,
        "请用绑定钱包核对地址、数量和 raw 后再签名。不想做了回「取消」，或在签名页点「取消这笔」。",
      ]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    /* plain text */
  }
  return raw;
}

export function cancelPendingTrade(ctx: ToolCtx): string {
  const had =
    Boolean(ctx.conversation.lastQuote) ||
    Boolean(ctx.conversation.lastLp) ||
    Boolean(ctx.conversation.lastIntent && !ctx.conversation.lastIntent.cancelled);
  const intentId = ctx.conversation.lastIntent?.cancelled ? undefined : ctx.conversation.lastIntent?.id;
  if (intentId) {
    try {
      ctx.intents.cancel(intentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/已经广播完成/.test(msg)) throw err;
      return msg;
    }
  }
  const next = ctx.conversations.cancelPending(ctx.conversation.id);
  ctx.conversation.userConfirmed = next.userConfirmed;
  delete ctx.conversation.lastQuote;
  delete ctx.conversation.lastLp;
  ctx.conversation.lastIntent = next.lastIntent;
  if (!had) return "当前没有待执行的报价或签名页。";
  return [
    "已取消。没有广播任何交易，币还在你钱包里。",
    "如果刚才只签过授权、没签兑换，钱包里可能仍有一笔有界授权，可自行撤销。",
    "再说一次标的和金额就能重新报价。",
  ].join("\n");
}

export function parseLocalCommand(text: string): LocalCmd {
  const t = text.trim();
  if (isUserCancel(t)) return { kind: "cancel" };
  if (isUserConfirm(t)) return { kind: "confirm" };
  if (POSITIONS.test(t)) return { kind: "positions" };
  const collect = t.match(COLLECT);
  if (collect) return collect[1] ? { kind: "collect", tokenId: collect[1] } : { kind: "collect" };
  if (DECREASE_FULL.test(t)) return { kind: "decrease", fractionBps: 10_000 };
  if (DECREASE_HALF.test(t)) return { kind: "decrease", fractionBps: 5_000 };
  const spokenLp = parseAddLp(t);
  if (spokenLp) {
    return {
      kind: "lp",
      token: spokenLp.token,
      amountTokenUi: spokenLp.amountTokenUi,
      amountQuoteUi: spokenLp.amountQuoteUi,
      budgetQuoteUi: spokenLp.budgetQuoteUi,
    };
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

async function pickPosition(ctx: ToolCtx, tokenId?: string) {
  const listed = JSON.parse(await runTool("list_positions", "{}", ctx)) as {
    positions: Array<{ tokenId: string; token0: string; token1: string }>;
  };
  if (tokenId) {
    const hit = listed.positions.find((p) => p.tokenId === tokenId);
    if (!hit) throw new Error(`找不到 NFT #${tokenId}，或不是这个钱包的白名单仓位。`);
    return hit;
  }
  if (listed.positions.length === 1) return listed.positions[0]!;
  if (!listed.positions.length) throw new Error("没有可操作的仓位。");
  throw new Error(
    `有 ${listed.positions.length} 个仓位，请写明编号，例如：收手续费 ${listed.positions[0]!.tokenId}`,
  );
}

export async function runLocalCommand(text: string, ctx: ToolCtx): Promise<string | null> {
  const cmd = parseLocalCommand(text);
  if (cmd.kind === "none") return null;

  if (cmd.kind === "cancel") {
    return cancelPendingTrade(ctx);
  }

  if (cmd.kind === "price") {
    return runTool("get_bstock_price", JSON.stringify({ token: cmd.token, quote: cmd.quote }), ctx);
  }

  if (cmd.kind === "positions") {
    return runTool("list_positions", "{}", ctx);
  }

  if (cmd.kind === "collect") {
    const pos = await pickPosition(ctx, cmd.tokenId);
    rememberLp(ctx, { token: pos.token0, collectTokenId: pos.tokenId });
    return [
      `将收取 NFT #${pos.tokenId}（${pos.token0}/${pos.token1}）的手续费，本金不动。`,
      "核对后回复「确认执行」。",
    ].join("\n");
  }

  if (cmd.kind === "decrease") {
    const pos = await pickPosition(ctx);
    rememberLp(ctx, { token: pos.token0, decreaseTokenId: pos.tokenId, decreaseBps: cmd.fractionBps });
    const label = cmd.fractionBps >= 10_000 ? "全部撤出（并烧掉 NFT）" : "撤出一半流动性";
    return [`将${label}：NFT #${pos.tokenId}（${pos.token0}/${pos.token1}）。`, "核对后回复「确认执行」。"].join("\n");
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
    rememberLp(ctx, {
      token: cmd.token,
      amountTokenUi: cmd.amountTokenUi,
      amountQuoteUi: cmd.amountQuoteUi,
      budgetQuoteUi: cmd.budgetQuoteUi,
      rangeBps: DEFAULT_LP_RANGE_BPS,
    });
    const analysis = await runTool(
      "analyze_lp",
      JSON.stringify({ token: cmd.token, rangeBps: DEFAULT_LP_RANGE_BPS }),
      ctx,
    );
    if (!hasMintSize(cmd)) {
      return [analysis, "", "若要加池，发送：加LP NVDAB 0.01 或 帮我加100u的英伟达lp，再回复「确认执行」。默认区间 ±30%。"].join("\n");
    }
    const size = cmd.budgetQuoteUi
      ? `总预算约 ${cmd.budgetQuoteUi} USDT（按区间公式拆成证书+稳定币，不是对半）`
      : [cmd.amountTokenUi && `${cmd.amountTokenUi} ${cmd.token}`, cmd.amountQuoteUi && `${cmd.amountQuoteUi} USDT`]
          .filter(Boolean)
          .join(" + ");
    return [
      analysis,
      "",
      `已记下加池：${size}，默认区间 ±30%。回复「确认执行」才会生成签名页。`,
    ].join("\n");
  }

  const lp = ctx.conversation.lastLp;
  const pending =
    lp?.collectTokenId || lp?.decreaseTokenId || lp?.increaseTokenId || hasMintSize(lp)
      ? { type: "lp" as const, ...lp }
      : ctx.conversation.lastQuote
        ? { type: "swap" as const, ...ctx.conversation.lastQuote }
        : null;
  if (!pending) {
    return "还没有待确认的报价。先发送：报价 USDT→NVDAB 10 或 加LP NVDAB 0.01 或 我的仓位";
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
      budgetQuoteUi: pending.budgetQuoteUi,
      rangeBps: pending.rangeBps ?? DEFAULT_LP_RANGE_BPS,
      fee: pending.fee,
      collectTokenId: pending.collectTokenId,
      increaseTokenId: pending.increaseTokenId,
      decreaseTokenId: pending.decreaseTokenId,
      decreaseBps: pending.decreaseBps,
    }),
    ctx,
  );
}
