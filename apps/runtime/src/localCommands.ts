import {
  DEFAULT_LP_RANGE_BPS,
  getToken,
  pickComparedPool,
  swapAssetSymbol,
  type CompareLpResult,
} from "@bstocks/chain";
import { isUserCancel, isUserConfirm } from "@bstocks/risk";
import type { PendingLp, PendingQuote } from "./conversation.js";
import { runTool, type ToolCtx } from "./tools.js";

export type LocalCmd =
  | { kind: "quote"; tokenIn: string; tokenOut: string; amountInUi: string }
  | { kind: "price"; token: string; quote: string }
  | { kind: "lp-compare"; token: string }
  | {
      kind: "lp";
      token: string;
      quote?: string;
      fee?: number;
      pick?: "highest" | "thickest";
      amountTokenUi?: string;
      amountQuoteUi?: string;
      budgetQuoteUi?: string;
    }
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
  `(?:查看|查一下|看看|查下|check|show)?\\s*([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:的)?(?:报价|价格|行情|\\s+(?:price|quote))`,
  "i",
);
const LP = new RegExp(
  `(?:加lp|加池|analyze[_\\s-]?lp|分析|add\\s*lp)\\s+(${TOK})(?:\\s+([\\d.]+))?(?:\\s+([\\d.]+))?`,
  "i",
);
const COLLECT = /^(?:收(?:取)?(?:手续)?费|harvest|collect(?:\s+fees?)?)(?:\s*#?\s*(\d+))?$/i;
const POSITIONS = /^(?:我的)?(?:仓位|持仓|positions?|my positions?)$/i;
const DECREASE_FULL = /^(全撤|撤出全部|全部撤出|撤出|withdraw all|exit all|close (?:the )?lp)$/i;
const DECREASE_HALF = /^(撤一半|减仓一半|撤 50%|withdraw half|exit half)$/i;

function spokenQuoteAsset(raw: string): string {
  const key = raw.toLowerCase();
  if (key === "bnb") return "BNB";
  if (key === "wbnb") return "WBNB";
  return "USDT";
}

export function parseBuySell(text: string): PendingQuote | null {
  const t = text.trim();
  const enBuy = t.match(
    new RegExp(`(?:buy|purchase)\\s+(\\d+(?:\\.\\d+)?)\\s*(usdt|usd|wbnb|bnb|u)\\s*(?:of|worth of)?\\s*(${TOK})`, "i"),
  );
  if (enBuy) {
    return { tokenIn: spokenQuoteAsset(enBuy[2]!), tokenOut: enBuy[3]!, amountInUi: enBuy[1]! };
  }
  const enSell = t.match(
    new RegExp(
      `(?:sell)\\s+(\\d+(?:\\.\\d+)?)\\s*(?:of\\s+)?([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:\\s+(?:for|to)\\s+(u|usdt|usd|wbnb|bnb))?\\s*$`,
      "i",
    ),
  );
  if (enSell) {
    return {
      tokenIn: enSell[2]!,
      tokenOut: enSell[3] ? spokenQuoteAsset(enSell[3]) : "USDT",
      amountInUi: enSell[1]!,
    };
  }
  const spend = t.match(
    new RegExp(
      `(?:用)?\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd|wbnb|bnb)\\s*(?:买|买入|要买|购入|换|兑)\\s*(?:成|到|得|的)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (spend) {
    return { tokenIn: spokenQuoteAsset(spend[2]!), tokenOut: spend[3]!, amountInUi: spend[1]! };
  }
  const buy = t.match(
    new RegExp(`(?:买|买入|要买|购入)\\s*(\\d+(?:\\.\\d+)?)\\s*(u|usdt|usd|wbnb|bnb)\\s*(?:的|得)?\\s*(${TOK})`, "i"),
  );
  if (buy) {
    return { tokenIn: spokenQuoteAsset(buy[2]!), tokenOut: buy[3]!, amountInUi: buy[1]! };
  }
  const sell = t.match(
    new RegExp(
      `(?:卖|卖出)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:个|股)?\\s*(?:的)?\\s*([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:\\s*(?:换|成|得)\\s*(u|usdt|usd|wbnb|bnb))?\\s*$`,
      "i",
    ),
  );
  if (sell) {
    return {
      tokenIn: sell[2]!,
      tokenOut: sell[3] ? spokenQuoteAsset(sell[3]) : "USDT",
      amountInUi: sell[1]!,
    };
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
    return swapAssetSymbol(symbol);
  } catch {
    return symbol.trim().toUpperCase();
  }
}

export function rememberLp(ctx: ToolCtx, lp: PendingLp) {
  ctx.conversation.lastLp = {
    ...lp,
    token: canonSymbol(lp.token),
    quote: lp.quote ? canonSymbol(lp.quote === "BNB" ? "WBNB" : lp.quote) : lp.quote,
    rangeBps: lp.rangeBps ?? DEFAULT_LP_RANGE_BPS,
  };
  delete ctx.conversation.lastQuote;
  ctx.conversations.save(ctx.conversation);
}

export function parseSpokenFee(text: string): number | undefined {
  const named = text.match(/(?:fee\s*)?(10000|2500|500|100)\b/i);
  if (named && /fee|档/i.test(text)) return Number(named[1]);
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!pct) return undefined;
  const bps = Math.round(Number(pct[1]) * 100);
  if (bps === 1 || bps === 5 || bps === 25 || bps === 100) return bps * 100;
  return undefined;
}

export function parseSpokenQuote(text: string): string | undefined {
  if (/\bwbnb\b/i.test(text)) return "WBNB";
  if (/\busdc\b/i.test(text)) return "USDC";
  if (/(?:usdt\s*(?:池|档|那个|pool|tier)|那个\s*usdt|\busdt\s+pool)/i.test(text)) return "USDT";
  if (/\bbnb\b/i.test(text) && /(?:池|档|那个|lp|pool|tier)/i.test(text)) return "WBNB";
  return undefined;
}

export function parseCompareLp(text: string): { token: string } | null {
  const t = text.trim();
  if (/(?:加|add)\b/i.test(t) && /\d/.test(t)) return null;
  if (
    !/(apr|年化|收益|哪个lp|哪[个個]池|池子怎么样|lp怎么样|流动性池|最高.*lp|lp.*最高|highest\s+apr|best\s+apr|which\s+pool|lp\s+apr)/i.test(
      t,
    )
  ) {
    return null;
  }
  const cleaned = t.replace(/^(?:查看|查一下|看看|查下|check|show|what(?:'s| is))\s*/i, "");
  const parts = cleaned.split(
    /(?:的)?(?:目前|当前|哪个|哪個|最高|apr|年化|收益|lp|池子?|流动性|怎么样|highest|best|yield)/i,
  );
  const token = (parts[0] || "").trim();
  if (!token || /最高|哪个|哪個|怎样|如何|highest|best/.test(token)) return null;
  return { token };
}

const FIAT = "u|usdt|usd|dollars?|刀|美金|美元|块";
const BEST_POOL =
  "最高apr|apr最高|年化最高|最高那个|那个最高|最高的|最好的|最好那个|最好的那个|highest(?:\\s+apr)?|best(?:\\s+(?:one|pool))?";

function parseLpPick(text: string): "highest" | "thickest" | undefined {
  if (/(最厚|tvl\s*最高|流动性最大|thickest|highest\s+tvl|deepest)/i.test(text)) return "thickest";
  if (new RegExp(BEST_POOL, "i").test(text)) return "highest";
  return undefined;
}

function stripLpSuffix(token: string): string {
  return token.replace(/(?:的)?(?:lp|加池|池子?|流动性)$/i, "").trim();
}

function cleanLpToken(raw: string): string {
  const token = stripLpSuffix(raw).replace(/[吧吗呢啊呀]+$/u, "").trim();
  if (!token || /最高|最好|那个|哪個|怎样|如何|池子|highest|best|that|pool/.test(token)) return "";
  return token;
}

export type ParsedAddLp = PendingLp & { pick?: "highest" | "thickest" };

export function parseAddLp(text: string): ParsedAddLp | null {
  const t = text.trim();
  const extras = () => {
    const quote = parseSpokenQuote(t);
    const fee = parseSpokenFee(t);
    const pick = parseLpPick(t);
    return {
      ...(quote ? { quote } : {}),
      ...(fee != null ? { fee } : {}),
      ...(pick ? { pick } : {}),
    };
  };
  const enBudgetHighest = t.match(
    new RegExp(
      `(?:add|put)\\s+(\\d+(?:\\.\\d+)?)\\s*(${FIAT})\\s*(?:to|into|in)?\\s*(?:the\\s+)?(?:${BEST_POOL})`,
      "i",
    ),
  );
  if (enBudgetHighest) {
    const tok = t.match(new RegExp(`(?:of|for)?\\s*(${TOK})(?:\\s+(?:lp|pool))?\\s*$`, "i"));
    return {
      token: tok?.[1] ? cleanLpToken(tok[1]) : "",
      budgetQuoteUi: enBudgetHighest[1]!,
      pick: "highest",
      ...extras(),
    };
  }
  const enBudgetToken = t.match(
    new RegExp(`(?:add|put)\\s+(\\d+(?:\\.\\d+)?)\\s*(${FIAT})\\s*(?:of|to|into)?\\s*(${TOK})`, "i"),
  );
  if (enBudgetToken) {
    return { token: cleanLpToken(enBudgetToken[3]!), budgetQuoteUi: enBudgetToken[1]!, ...extras() };
  }
  const budgetHighest = t.match(
    new RegExp(
      `(?:帮我|请|想要?)?加\\s*(\\d+(?:\\.\\d+)?)\\s*(${FIAT})\\s*(?:的|到)?(?:那个)?(?:${BEST_POOL})`,
      "i",
    ),
  );
  if (budgetHighest) {
    const tok = t.match(new RegExp(`(?:的)?\\s*(${TOK})(?:的)?(?:lp|池|流动性)?\\s*$`, "i"));
    return {
      token: tok?.[1] ? cleanLpToken(tok[1]) : "",
      budgetQuoteUi: budgetHighest[1]!,
      pick: "highest",
      ...extras(),
    };
  }
  const budgetThenToken = t.match(
    new RegExp(
      `(?:帮我|请|想要?)?加\\s*(\\d+(?:\\.\\d+)?)\\s*(${FIAT})\\s*(?:的)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (budgetThenToken) {
    return { token: cleanLpToken(budgetThenToken[3]!), budgetQuoteUi: budgetThenToken[1]!, ...extras() };
  }
  const spendThenToken = t.match(
    new RegExp(
      `(?:用|把)\\s*(\\d+(?:\\.\\d+)?)\\s*(${FIAT})\\s*(?:去|来|拿去)?\\s*加\\s*(?:成)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (spendThenToken) {
    return { token: cleanLpToken(spendThenToken[3]!), budgetQuoteUi: spendThenToken[1]!, ...extras() };
  }
  const tokenThenBudget = t.match(
    new RegExp(
      `(?:加lp|加池|加)\\s*([A-Za-z\\u4e00-\\u9fff]+)\\s*(?:lp|池|流动性)?\\s*(\\d+(?:\\.\\d+)?)\\s*(${FIAT})`,
      "i",
    ),
  );
  if (tokenThenBudget) {
    return { token: cleanLpToken(tokenThenBudget[1]!), budgetQuoteUi: tokenThenBudget[2]!, ...extras() };
  }
  return null;
}

function recoverBudgetUi(ctx: ToolCtx): string | undefined {
  const turns = [...(ctx.conversation.turns ?? [])].reverse();
  for (const turn of turns.slice(0, 8)) {
    if (turn.role !== "user") continue;
    const m = turn.content.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${FIAT})\\b`, "i"));
    if (m && /加|add|lp|池/i.test(turn.content)) return m[1];
  }
  return undefined;
}

async function hydratePendingLp(ctx: ToolCtx): Promise<PendingLp | undefined> {
  let lp = ctx.conversation.lastLp;
  if (hasMintSize(lp)) return lp;
  const budget = recoverBudgetUi(ctx);
  if (!budget) return lp;
  if (lp?.token) {
    rememberLp(ctx, { ...lp, budgetQuoteUi: budget });
    return ctx.conversation.lastLp;
  }
  const cmp = ctx.conversation.lastLpCompare;
  if (!cmp) return lp;
  const picked = pickComparedPool(cmp, { pick: "highest" });
  if (!picked || picked.thin) return lp;
  rememberLp(ctx, {
    token: picked.token,
    quote: picked.quote,
    fee: picked.fee,
    budgetQuoteUi: budget,
    rangeBps: DEFAULT_LP_RANGE_BPS,
  });
  return ctx.conversation.lastLp;
}

function hasMintSize(lp?: PendingLp): boolean {
  return Boolean(lp && (lp.amountTokenUi || lp.amountQuoteUi || lp.budgetQuoteUi));
}

function formatAnalyzeLp(raw: string): string {
  try {
    const a = JSON.parse(raw) as {
      token0?: string;
      token1?: string;
      fee?: number;
      midQuotePerToken?: string;
      tvlUsdApprox?: string;
      suggestedRangeBps?: number;
      priceLower?: string;
      priceUpper?: string;
      warnings?: string[];
      pool?: string;
    };
    if (!a.pool || a.midQuotePerToken == null) return raw;
    const tvl = Number(a.tvlUsdApprox);
    const tvlText = Number.isFinite(tvl) ? `~$${Math.round(tvl).toLocaleString("en-US")}` : String(a.tvlUsdApprox);
    const fee = a.fee != null ? `${(a.fee / 10_000).toFixed(2)}%` : "";
    const lo = a.priceLower != null ? Number(a.priceLower).toFixed(4) : "";
    const hi = a.priceUpper != null ? Number(a.priceUpper).toFixed(4) : "";
    const range = a.suggestedRangeBps != null ? `±${(a.suggestedRangeBps / 100).toFixed(0)}%` : "";
    return [
      `${a.token0}/${a.token1} · fee ${fee} · mid ~ ${a.midQuotePerToken} ${a.token1}/${a.token0}`,
      `Pool TVL ${tvlText}${range ? ` · suggested range ${range}` : ""}${lo && hi ? `: ${lo}–${hi}` : ""}`,
      ...(a.warnings ?? []),
    ].join("\n");
  } catch {
    return raw;
  }
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
      kind?: string;
      disclaimer?: string;
      highestApr?: { quote: string; feeLabel: string; apr24hPct: number; tvlUsd: number };
      thickest?: { quote: string; feeLabel: string; tvlUsd: number };
      pools?: Array<{
        quote: string;
        feeLabel: string;
        apr24hPct: number;
        tvlUsd: number;
        volumeUsd24h: number;
        thin: boolean;
      }>;
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
      return ["Risk check failed. No signer page was created.", ...(data.blockers ?? [])].join("\n");
    }
    if (data.error === "insufficient_balance") {
      return data.message ?? "Insufficient balance.";
    }
    if (data.kind === "lp-compare" && Array.isArray(data.pools)) {
      if (!data.pools.length) {
        return "No whitelist Pancake V3 pools for this token (USDT/USDC/WBNB only).";
      }
      const lines = data.pools.map((p) => {
        const flag = p.thin ? " · thin, numbers are informational only" : "";
        return `${p.quote} ${p.feeLabel} · fee APR ${p.apr24hPct.toFixed(1)}% · TVL $${Math.round(p.tvlUsd).toLocaleString("en-US")} · 24h $${Math.round(p.volumeUsd24h).toLocaleString("en-US")}${flag}`;
      });
      const top = data.highestApr
        ? `Highest non-thin: ${data.highestApr.quote} ${data.highestApr.feeLabel}, about ${data.highestApr.apr24hPct.toFixed(1)}% (24h fee APR).`
        : "No pool clears the liquidity floor, so highest-APR mint is blocked.";
      const thick = data.thickest
        ? `Thickest TVL: ${data.thickest.quote} ${data.thickest.feeLabel}, about $${Math.round(data.thickest.tvlUsd).toLocaleString("en-US")}.`
        : "";
      return [
        top,
        thick,
        "",
        ...lines,
        "",
        data.disclaimer ??
          "Not a yield promise. To mint a tier: add 100u to the highest / add 100u NVIDIA WBNB 0.25%.",
      ]
        .filter((x) => x !== "")
        .join("\n");
    }
    if (data.display && data.uiPrice) {
      return [
        data.display,
        "This is the pool mid (how much quote asset 1 share is worth), not investment advice.",
        "To trade, state an amount, e.g. buy 100 USDT of NVIDIA / 用 100 USDT 买英伟达.",
      ].join("\n");
    }
    if (Array.isArray(data.positions)) {
      if (!data.positions.length) {
        return "No whitelist bStock V3 positions on the bound wallet. Say addLP NVDAB 0.01 to open one (default ±30%).";
      }
      const lines = data.positions.map((p) => {
        const range = p.inRange ? "in range" : "out of range, no longer earning fees";
        return [
          `#${p.tokenId} ${p.token0}/${p.token1} ${(p.fee / 10000).toFixed(2)}% · ${range}`,
          `Exposure ${p.amount0Ui} ${p.token0} + ${p.amount1Ui} ${p.token1} · mark ~$${p.markUsd}`,
          `Uncollected ~$${p.feesUsdApprox} · range ${p.priceLower}–${p.priceUpper}`,
        ].join("\n");
      });
      return [
        `${data.count ?? data.positions.length} position(s) (not a yield promise):`,
        ...lines,
        "Collect with collect / 收手续费. Exit with withdraw all / 全撤 or withdraw half / 撤一半, then confirm.",
      ].join("\n\n");
    }
    if (data.signerUrl) {
      const s = data.summary ?? {};
      const pair =
        s.tokenIn && s.tokenOut
          ? `${s.amountInUi ?? ""} ${s.tokenIn} → ~${s.amountOutUi ?? "?"} ${s.tokenOut}`
          : s.token0 && s.token1
            ? `${s.amount0Ui ?? ""} ${s.token0} + ${s.amount1Ui ?? ""} ${s.token1}${s.rangeLabel ? ` · ${s.rangeLabel}` : ""}${s.rangePrices ? ` · ${s.rangePrices}` : ""}${s.tokenId ? ` · #${s.tokenId}` : ""}`
            : "";
      return [
        "Signer intent created from the last confirmed plan (not investment advice).",
        pair.trim(),
        `Signer: ${data.signerUrl}`,
        "Use the bound wallet. Check address, amounts, and raw before signing. To stop, say cancel / 取消, or tap Cancel on the signer page.",
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
      if (!/Already broadcast/.test(msg)) throw err;
      return msg;
    }
  }
  const next = ctx.conversations.cancelPending(ctx.conversation.id);
  ctx.conversation.userConfirmed = next.userConfirmed;
  delete ctx.conversation.lastQuote;
  delete ctx.conversation.lastLp;
  ctx.conversation.lastIntent = next.lastIntent;
  if (!had) return "There is no pending quote or signer page.";
  return [
    "Cancelled. Nothing was broadcast; tokens stay in your wallet.",
    "If you only signed the approve, a bounded allowance may still sit on-chain — you can revoke it yourself.",
    "Restate the token and amount to requote.",
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
      ...(spokenLp.quote ? { quote: spokenLp.quote } : {}),
      ...(spokenLp.fee != null ? { fee: spokenLp.fee } : {}),
      ...(spokenLp.pick ? { pick: spokenLp.pick } : {}),
      ...(spokenLp.amountTokenUi ? { amountTokenUi: spokenLp.amountTokenUi } : {}),
      ...(spokenLp.amountQuoteUi ? { amountQuoteUi: spokenLp.amountQuoteUi } : {}),
      ...(spokenLp.budgetQuoteUi ? { budgetQuoteUi: spokenLp.budgetQuoteUi } : {}),
    };
  }
  const compared = parseCompareLp(t);
  if (compared) return { kind: "lp-compare", token: compared.token };
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

async function ensureLpCompare(ctx: ToolCtx, token: string): Promise<CompareLpResult> {
  const cur = ctx.conversation.lastLpCompare;
  try {
    if (cur && getToken(cur.token).symbol === getToken(token).symbol) return cur;
  } catch {
    /* refresh */
  }
  const raw = await runTool("compare_lp_pools", JSON.stringify({ token }), ctx);
  const next = ctx.conversation.lastLpCompare;
  if (next) return next;
  return JSON.parse(raw) as CompareLpResult;
}

async function resolveLpPool(
  ctx: ToolCtx,
  cmd: Extract<LocalCmd, { kind: "lp" }>,
): Promise<{ token: string; quote: string; fee: number; feeLabel: string; aprLabel: string }> {
  const token = cmd.token || ctx.conversation.lastLpCompare?.token || ctx.conversation.lastLp?.token;
  if (!token) throw new Error("Name a token first, e.g. NVIDIA highest apr, or add 100u NVIDIA.");
  const wantsNamedPool = Boolean(cmd.pick || cmd.quote || cmd.fee != null);
  if (!wantsNamedPool) {
    return {
      token,
      quote: "USDT",
      fee: 2500,
      feeLabel: "0.25%",
      aprLabel: "unspecified tier",
    };
  }
  const cmp = await ensureLpCompare(ctx, token);
  const picked = pickComparedPool(cmp, { pick: cmd.pick, quote: cmd.quote, fee: cmd.fee });
  if (!picked) {
    throw new Error(`No whitelist V3 pool to mint (${token}${cmd.quote ? " / " + cmd.quote : ""}). Ask "${token} highest apr" first.`);
  }
  if (picked.thin && cmd.pick === "highest") {
    throw new Error("No pool clears the liquidity floor, so highest-APR mint is blocked. Name a tier such as USDT 0.25%.");
  }
  return {
    token: picked.token,
    quote: picked.quote,
    fee: picked.fee,
    feeLabel: picked.feeLabel,
    aprLabel: `${picked.apr24hPct.toFixed(1)}%`,
  };
}

async function pickPosition(ctx: ToolCtx, tokenId?: string) {
  const listed = JSON.parse(await runTool("list_positions", "{}", ctx)) as {
    positions: Array<{ tokenId: string; token0: string; token1: string }>;
  };
  if (tokenId) {
    const hit = listed.positions.find((p) => p.tokenId === tokenId);
    if (!hit) throw new Error(`NFT #${tokenId} not found, or it is not a whitelist position of this wallet.`);
    return hit;
  }
  if (listed.positions.length === 1) return listed.positions[0]!;
  if (!listed.positions.length) throw new Error("No positions to manage.");
  throw new Error(
    `${listed.positions.length} positions found. Specify the id, e.g. collect ${listed.positions[0]!.tokenId}`,
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
      `Will collect fees from NFT #${pos.tokenId} (${pos.token0}/${pos.token1}). Principal stays.`,
      "Reply confirm / 确认执行 after you check.",
    ].join("\n");
  }

  if (cmd.kind === "decrease") {
    const pos = await pickPosition(ctx);
    rememberLp(ctx, { token: pos.token0, decreaseTokenId: pos.tokenId, decreaseBps: cmd.fractionBps });
    const label = cmd.fractionBps >= 10_000 ? "withdraw all (and burn the NFT)" : "withdraw half the liquidity";
    return [`Will ${label}: NFT #${pos.tokenId} (${pos.token0}/${pos.token1}).`, "Reply confirm / 确认执行 after you check."].join("\n");
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
      "Read-only quote, not investment advice. Reply confirm / 确认执行 after checking raw vs UI to get a signer link.",
    ].join("\n");
  }

  if (cmd.kind === "lp-compare") {
    return runTool("compare_lp_pools", JSON.stringify({ token: cmd.token }), ctx);
  }

  if (cmd.kind === "lp") {
    const selected = await resolveLpPool(ctx, cmd);
    rememberLp(ctx, {
      token: selected.token,
      quote: selected.quote,
      fee: selected.fee,
      amountTokenUi: cmd.amountTokenUi,
      amountQuoteUi: cmd.amountQuoteUi,
      budgetQuoteUi: cmd.budgetQuoteUi,
      rangeBps: DEFAULT_LP_RANGE_BPS,
    });
    const analysis = formatAnalyzeLp(
      await runTool(
        "analyze_lp",
        JSON.stringify({
          token: selected.token,
          quote: selected.quote,
          fee: selected.fee,
          rangeBps: DEFAULT_LP_RANGE_BPS,
        }),
        ctx,
      ),
    );
    if (!hasMintSize(cmd)) {
      return [analysis, "", "To mint, send addLP NVDAB 0.01 or add 100u NVIDIA lp, then confirm. Default range ±30%."].join("\n");
    }
    const size = cmd.budgetQuoteUi
      ? `Budget ~ ${cmd.budgetQuoteUi} u (split by the range formula into certificate + ${selected.quote}, not 50/50)`
      : [cmd.amountTokenUi && `${cmd.amountTokenUi} ${cmd.token}`, cmd.amountQuoteUi && `${cmd.amountQuoteUi} ${selected.quote}`]
          .filter(Boolean)
          .join(" + ");
    const pool = `${selected.quote} ${selected.feeLabel}`;
    const apr =
      selected.aprLabel === "unspecified tier"
        ? "Not a yield promise."
        : `About ${selected.aprLabel} 24h fee APR, not a promise.`;
    return [
      analysis,
      "",
      `Noted LP mint: ${size} · ${pool}, default range ±30%. Reply confirm / 确认执行 to get a signer page. ${apr}`,
    ].join("\n");
  }

  const lp = await hydratePendingLp(ctx);
  const pending =
    lp?.collectTokenId || lp?.decreaseTokenId || lp?.increaseTokenId || hasMintSize(lp)
      ? { type: "lp" as const, ...lp }
      : ctx.conversation.lastQuote
        ? { type: "swap" as const, ...ctx.conversation.lastQuote }
        : null;
  if (!pending) {
    return "No pending quote. Try: quote USDT→NVDAB 10, addLP NVDAB 0.01, or my positions.";
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
      quote: pending.quote,
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
