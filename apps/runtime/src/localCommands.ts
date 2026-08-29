import {
  aliasesFor,
  DEFAULT_LP_RANGE_BPS,
  getToken,
  isWhitelisted,
  findWhitelistedTokenInText,
  listTokens,
  pickComparedPool,
  swapAssetSymbol,
  type CompareLpResult,
} from "@bstocks/chain";
import { isUserCancel, isUserConfirm } from "@bstocks/risk";
import { nextConfirmKind, type PendingLp, type PendingQuote, isFundingSwapForLp, isBuyThenLp, latchSwapThenLpPlan, parkedMint } from "./conversation.js";
import { serviceFeeLabel } from "./hire.js";
import { runTool, continueSwapThenLp, maybeSettleLpAfterTx, intentFilled, lpSignerIsReusable, type ToolCtx } from "./tools.js";
import { lpPickWantsExecute, parseLpPick as parseLpOptionNumber } from "./lpPropose.js";

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
  | { kind: "increase"; amountTokenUi?: string; amountQuoteUi?: string }
  | { kind: "catalog" }
  | { kind: "sell-dust" }
  | { kind: "amend-half" }
  | { kind: "amend-pay"; tokenIn: string; amountInUi?: string }
  | { kind: "requote" }
  | { kind: "confirm" }
  | { kind: "proceed" }
  | { kind: "cancel" }
  | { kind: "hire-offer" }
  | { kind: "deliver" }
  | { kind: "none" };

/** Cancel/confirm/positions/collect/withdraw stay rule-based. Other parsed intents go to the LLM when a key is set. */
export function bypassLlm(kind: LocalCmd["kind"], hasLlm: boolean): boolean {
  if (kind === "none") return false;
  if (kind === "cancel" || kind === "confirm" || kind === "proceed") return true;
  if (
    kind === "positions" ||
    kind === "collect" ||
    kind === "decrease" ||
    kind === "increase" ||
    kind === "catalog" ||
    kind === "sell-dust" ||
    kind === "amend-half" ||
    kind === "amend-pay" ||
    kind === "requote" ||
    kind === "quote" ||
    kind === "price"
  ) {
    return true;
  }
  return !hasLlm;
}

const TOK = "[A-Za-z0-9\\u4e00-\\u9fff]+";
const PAIR = new RegExp(
  `(?:报价|quote)\\s+(${TOK})\\s*(?:→|->|=>|to|换|兑)?\\s*(${TOK})\\s+([\\d.]+)`,
  "i",
);
const PRICE = new RegExp(`(?:价格|price)\\s+(${TOK})(?:\\s*/\\s*(${TOK}))?`, "i");
const PRICE_LOOSE = new RegExp(
  `(?:查看|查一下|看看|查下|查询一下|查询|check|show)?\\s*([A-Za-z]{2,12}|[\\u4e00-\\u9fff]{2,8})(?:的)?(?:报价|价格|行情|\\s+(?:price|quote))`,
  "i",
);
const LP = new RegExp(
  `(?:加lp|加池|analyze[_\\s-]?lp|分析|add\\s*lp)\\s+(${TOK})(?:\\s+([\\d.]+))?(?:\\s+([\\d.]+))?`,
  "i",
);
const COLLECT = /^(?:收(?:取)?(?:手续)?费|领取(?:一下)?(?:手续)?费|harvest|collect(?:\s+fees?)?)(?:\s*#?\s*(\d+))?$/i;
const POSITIONS = /^(?:我的)?(?:仓位|持仓|positions?|my positions?)$/i;
const DECREASE_FULL = /^(全撤|撤出全部|全部撤出|撤出|退出全部仓位|退出仓位|赎回|withdraw all|exit all|close (?:the )?lp)$/i;
const DECREASE_HALF = /^(撤一半|减仓一半|撤 50%|withdraw half|exit half)$/i;

function isPositionsSpeech(text: string): boolean {
  const t = text.trim();
  if (POSITIONS.test(t)) return true;
  if (/(赎回|退出|撤出|领取|收取|组\s*lp|加池|加\s*lp)/i.test(t)) return false;
  if (/^(?:看看|查一下|查下|查看|帮我看)?(?:一下)?(?:我的)?(?:lp\s*)?(?:仓位|持仓)(?:呢|吗|啊)?[。.!！]?$/i.test(t)) return true;
  if (/我还有(?:仓位|lp|持仓)/i.test(t)) return true;
  if (/^(?:lp仓位|看看lp|我的lp|查lp)[。.!！]?$/i.test(t)) return true;
  return false;
}

function parseCollectSpeech(text: string): Extract<LocalCmd, { kind: "collect" }> | null {
  const t = text.trim();
  const exact = t.match(COLLECT);
  if (exact) return exact[1] ? { kind: "collect", tokenId: exact[1] } : { kind: "collect" };
  if (/(?:组|加)\s*(?:个)?(?:lp|池)/i.test(t)) return null;
  if (/(赎回|退出|撤出|decrease|withdraw)/i.test(t)) return null;
  if (/(领取|收取|收一下|领一下).{0,12}(手续费|fee)/i.test(t) || /^(?:领手续费|收fee)$/i.test(t)) {
    const id = t.match(/#?\s*(\d{3,})/);
    return id?.[1] ? { kind: "collect", tokenId: id[1] } : { kind: "collect" };
  }
  return null;
}

function isDecreaseFullSpeech(text: string): boolean {
  const t = text.trim();
  if (DECREASE_FULL.test(t)) return true;
  if (/(?:组|加)\s*(?:个)?(?:lp|池)/i.test(t) && !/赎回|退出|撤/.test(t)) return false;
  if (
    /(赎回|退出全部|全部退出|全部赎回|撤出仓位|关掉仓位|关闭仓位|清掉仓位|remove (?:all )?lp|exit (?:the )?(?:lp )?position|close (?:the )?(?:lp )?position)/i.test(
      t,
    )
  ) {
    return /lp|仓位|流动性|池|nft/i.test(t) || /^(赎回|退出全部仓位|退出仓位)$/i.test(t);
  }
  return false;
}

const QUOTE_ASSET = "usdc|usdt|usd|wbnb|bnb|u";

function spokenQuoteAsset(raw: string): string {
  const key = raw.toLowerCase();
  if (key === "usdc") return "USDC";
  if (key === "bnb") return "BNB";
  if (key === "wbnb") return "WBNB";
  return "USDT";
}

export function wantsLpAfterTrade(text: string): boolean {
  const t = text.trim();
  if (/(?:然后|再|接着|并|同时).{0,12}(?:组|加).{0,8}(?:lp|LP|池)/i.test(t)) return true;
  if (/(?:买|买入).{0,24}(?:然后|再).{0,8}(?:组|加).{0,8}(?:lp|LP|池)/i.test(t)) return true;
  return false;
}

function signerTtlMinutes(): number {
  const ms = Number(process.env.INTENT_TTL_MS ?? "600000");
  return Math.max(1, Math.round((Number.isFinite(ms) ? ms : 600_000) / 60_000));
}

function stripLpAfterClause(text: string): string {
  return text.replace(/\s*(?:然后|再|接着|并|同时).{0,16}(?:组|加).{0,8}(?:lp|LP|池).*$/i, "").trim();
}

export function parseBuySell(text: string): PendingQuote | null {
  const t = stripLpAfterClause(text.trim());
  const enBuy = t.match(
    new RegExp(`(?:buy|purchase)\\s+(\\d+(?:\\.\\d+)?)\\s*(${QUOTE_ASSET})\\s*(?:of|worth of)?\\s*(${TOK})`, "i"),
  );
  if (enBuy) {
    return { tokenIn: spokenQuoteAsset(enBuy[2]!), tokenOut: enBuy[3]!, amountInUi: enBuy[1]! };
  }
  const enSell = t.match(
    new RegExp(
      `(?:sell)\\s+(\\d+(?:\\.\\d+)?)\\s*(?:of\\s+)?([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:\\s+(?:for|to)\\s+(${QUOTE_ASSET}))?\\s*$`,
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
      `(?:用)?\\s*(\\d+(?:\\.\\d+)?)\\s*(${QUOTE_ASSET})\\s*(?:买|买入|要买|购入|换|兑)\\s*(?:成|到|得|的)?\\s*(${TOK})`,
      "i",
    ),
  );
  if (spend) {
    return { tokenIn: spokenQuoteAsset(spend[2]!), tokenOut: spend[3]!, amountInUi: spend[1]! };
  }
  const buy = t.match(
    new RegExp(`(?:买|买入|要买|购入)\\s*(\\d+(?:\\.\\d+)?)\\s*(${QUOTE_ASSET})\\s*(?:的|得)?\\s*(${TOK})`, "i"),
  );
  if (buy) {
    return { tokenIn: spokenQuoteAsset(buy[2]!), tokenOut: buy[3]!, amountInUi: buy[1]! };
  }
  const sell = t.match(
    new RegExp(
      `(?:卖|卖出)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:个|股)?\\s*(?:的)?\\s*([A-Za-z0-9\\u4e00-\\u9fff]+?)(?:\\s*(?:换|成|得)\\s*(${QUOTE_ASSET}))?\\s*$`,
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
  const allBuy = t.match(
    new RegExp(`(?:用)?全部(?:的)?\\s*(${QUOTE_ASSET})\\s*(?:去)?(?:买|买入|换|兑)\\s*(?:成|到|得)?\\s*(${TOK})`, "i"),
  );
  if (allBuy) {
    return { tokenIn: spokenQuoteAsset(allBuy[1]!), tokenOut: allBuy[2]!, amountInUi: "all" };
  }
  const allSell = t.match(
    new RegExp(
      `(?:把)?全部(?:的)?\\s*([A-Za-z0-9\\u4e00-\\u9fff]+?)\\s*(?:卖掉?|换成)\\s*(?:成)?\\s*(${QUOTE_ASSET})?`,
      "i",
    ),
  );
  if (allSell && !/^(usdt|usdc|bnb|wbnb|usd|u)$/i.test(allSell[1]!)) {
    return {
      tokenIn: allSell[1]!,
      tokenOut: allSell[2] ? spokenQuoteAsset(allSell[2]) : "USDT",
      amountInUi: "all",
    };
  }
  return null;
}

export async function fillAllAmount(ctx: ToolCtx, quote: PendingQuote): Promise<PendingQuote> {
  if (quote.amountInUi.toLowerCase() !== "all") return quote;
  const raw = await runTool("read_balance", JSON.stringify({ token: quote.tokenIn }), ctx);
  const parsed = JSON.parse(raw) as { uiDisplay?: string };
  const ui = parsed.uiDisplay?.trim();
  if (!ui || ui === "0") throw new Error(`绑定钱包没有足够的 ${quote.tokenIn} 可用来交易。`);
  return { ...quote, amountInUi: ui };
}

export function rememberSwapQuote(ctx: ToolCtx, quote: PendingQuote) {
  const swap = {
    tokenIn: canonSymbol(quote.tokenIn),
    tokenOut: canonSymbol(quote.tokenOut),
    amountInUi: quote.amountInUi,
  };
  if (ctx.conversation.pendingPlan?.kind === "swap_then_lp") {
    if (ctx.conversation.pendingPlan.phase === "swap" && !ctx.conversation.pendingPlan.swapIntentId) {
      latchSwapThenLpPlan(ctx.conversation, swap, ctx.conversation.pendingPlan.lp);
      ctx.conversations.save(ctx.conversation);
    }
    return;
  }
  if (parkedMint(ctx.conversation.lastLp) && (isFundingSwapForLp(swap, ctx.conversation.lastLp) || isBuyThenLp(swap, ctx.conversation.lastLp))) {
    latchSwapThenLpPlan(ctx.conversation, swap, ctx.conversation.lastLp!);
    ctx.conversations.save(ctx.conversation);
    return;
  }
  ctx.conversation.lastQuote = swap;
  if (ctx.conversation.pendingPlan?.kind !== "swap_then_lp") delete ctx.conversation.lastLp;
  ctx.conversations.save(ctx.conversation);
}

function canonSymbol(symbol: string): string {
  try {
    return swapAssetSymbol(symbol);
  } catch {
    return symbol.trim().toUpperCase();
  }
}

export async function applyLpPick(ctx: ToolCtx, n: number): Promise<string> {
  const prop = ctx.conversation.lastLpProposal;
  if (!prop?.options?.length) {
    return JSON.stringify({ error: "no_pending", message: "没有待选的组 LP 方案。请先说「组 LP」。" });
  }
  const opt = prop.options.find((o) => o.n === n);
  if (!opt) {
    return JSON.stringify({ error: "no_pending", message: `没有方案 ${n}。请回复列出的数字。` });
  }
  if (opt.action === "blocked") {
    return JSON.stringify({ error: "no_pending", message: opt.note });
  }
  ctx.conversation.lastLpProposal = { ...prop, selected: n };
  ctx.conversations.save(ctx.conversation);
  if (opt.action === "fund" && opt.funding) {
    return runTool(
      "plan_swap_then_lp",
      JSON.stringify({
        tokenIn: opt.funding.tokenIn,
        tokenOut: opt.funding.tokenOut,
        amountInUi: opt.funding.amountInUi,
        lpToken: opt.token,
        lpQuote: opt.quote,
        lpFee: opt.fee,
        budgetQuoteUi: opt.budgetQuoteUi ?? opt.needQuoteUi,
      }),
      ctx,
    );
  }
  rememberLp(ctx, {
    token: opt.token,
    quote: opt.quote,
    fee: opt.fee,
    amountTokenUi: opt.amountTokenUi,
    amountQuoteUi: opt.amountQuoteUi,
    budgetQuoteUi: opt.budgetQuoteUi,
    rangeBps: DEFAULT_LP_RANGE_BPS,
    committed: true,
  });
  return JSON.stringify({
    kind: "lp-picked",
    message: `已记下方案 ${n}：${opt.title}。大约 ${opt.needTokenUi} ${opt.token} + ${opt.needQuoteUi} ${opt.quote}。回复「确认」生成签名页（不是投资建议）。`,
  });
}

export async function applyLpPickFromText(ctx: ToolCtx, text: string): Promise<string | null> {
  const pick = parseLpOptionNumber(text);
  if (pick == null || !ctx.conversation.lastLpProposal) return null;
  const raw = await applyLpPick(ctx, pick);
  if (!lpPickWantsExecute(text)) return raw;
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return raw;
  } catch {
    return raw;
  }
  ctx.conversation.userConfirmed = true;
  ctx.conversations.save(ctx.conversation);
  const executed = await runLocalCommand("确认执行", ctx);
  return executed ?? raw;
}

export function rememberLp(ctx: ToolCtx, lp: PendingLp) {
  ctx.conversation.lastLp = {
    ...lp,
    token: canonSymbol(lp.token),
    quote: lp.quote ? canonSymbol(lp.quote === "BNB" ? "WBNB" : lp.quote) : lp.quote,
    rangeBps: lp.rangeBps ?? DEFAULT_LP_RANGE_BPS,
  };
  if (lp.collectTokenId || lp.decreaseTokenId || lp.increaseTokenId) {
    delete ctx.conversation.pendingPlan;
    delete ctx.conversation.lastLpProposal;
    delete ctx.conversation.lastQuote;
    ctx.conversations.save(ctx.conversation);
    return;
  }
  if (ctx.conversation.lastQuote && latchSwapThenLpPlan(ctx.conversation, ctx.conversation.lastQuote, ctx.conversation.lastLp)) {
    ctx.conversations.save(ctx.conversation);
    return;
  }
  if (!ctx.conversation.pendingPlan) delete ctx.conversation.lastQuote;
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
  const token = stripLpSuffix(raw)
    .replace(/[的之]$/u, "")
    .replace(/[吧吗呢啊呀]+$/u, "")
    .trim();
  if (!token || /最高|最好|最优|那个|哪個|怎样|如何|池子|highest|best|that|pool/.test(token)) return "";
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
  const sized = /\d+(?:\.\d+)?\s*(?:u|usdt|usd|dollars?|刀|美金|美元|块|bnb|wbnb|股|份)/i.test(t);
  if (!sized && !/\d/.test(t) && /(?:组|加|做)\s*.{0,32}(?:lp|LP|池)/i.test(t)) {
    const tokenOpen = t.match(
      /(?:组|加|做)\s*(?:个)?\s*([A-Za-z][A-Za-z0-9]{1,14}|[\u4e00-\u9fff]{2,8})\s*的?\s*(?:lp|LP|池)/i,
    );
    const captured = tokenOpen?.[1] ? cleanLpToken(tokenOpen[1]) : "";
    const token =
      (captured && isWhitelisted(captured) ? captured : "") ||
      findWhitelistedTokenInText(t) ||
      captured;
    return { token, ...extras() };
  }
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

function chineseAlias(symbol: string): string | undefined {
  try {
    return aliasesFor(symbol).find((a) => /[\u4e00-\u9fff]/.test(a));
  } catch {
    return undefined;
  }
}

function tokenSpoken(symbol: string, name: string | undefined, zh: boolean): string {
  const cn = chineseAlias(symbol);
  if (zh) return cn ? `${symbol}（${cn}）` : symbol;
  const short = name?.replace(/\s*\(bStocks\)\s*/i, "").trim();
  return short && short !== symbol ? `${symbol} (${short})` : symbol;
}

function trimUiAmount(ui: string): string {
  const n = Number(ui);
  if (!Number.isFinite(n)) return ui;
  const digits = Math.abs(n) >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function feePct(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

type QuoteTokenJson = { symbol: string; name?: string; kind?: string };

function formatSwapQuote(data: {
  tokenIn: QuoteTokenJson;
  tokenOut: QuoteTokenJson;
  amountInUi: string;
  amountOutUi: string;
  fee: number;
  nativeIn?: boolean;
  nativeOut?: boolean;
  hops?: Array<{ tokenIn: string; tokenOut: string; fee: number }>;
}, zh: boolean): string {
  const buyingBstock = data.tokenOut.kind === "bstock";
  const paySym = data.nativeIn ? "BNB" : data.tokenIn.symbol;
  const getSym = data.nativeOut ? "BNB" : data.tokenOut.symbol;
  const outLabel = tokenSpoken(data.tokenOut.symbol, data.tokenOut.name, zh);
  const hop = data.hops?.[0];
  const poolIn = hop?.tokenIn ?? data.tokenIn.symbol;
  const poolOut = hop?.tokenOut ?? data.tokenOut.symbol;
  const poolFee = feePct(hop?.fee ?? data.fee);
  const payNote = data.nativeIn
    ? zh
      ? "（原生 BNB，不是 WBNB）"
      : " (native BNB, not WBNB)"
    : "";
  if (zh) {
    const title = buyingBstock ? `买入 ${outLabel}` : `卖出 ${tokenSpoken(data.tokenIn.symbol, data.tokenIn.name, true)}`;
    return [
      "报价如下：",
      "",
      title,
      `- 支付：${trimUiAmount(data.amountInUi)} ${paySym}${payNote}`,
      `- 获得：约 ${trimUiAmount(data.amountOutUi)} ${getSym}`,
      `- 路由：Pancake V3（${poolIn}/${poolOut} ${poolFee} 池）`,
      "- 滑点：默认 50 bps（上限 80 bps）",
      "",
      "风险：",
      "- bStocks 是证书式敞口，不是直接持股，没有投票权；链上价格可能偏离美股。",
      "- 非交易时段价差可能更大。",
      "- 不是投资建议，是否执行由你决定。",
      "",
      `看完回复「确认」出签名页。取消回复「取消」。签名页约 ${signerTtlMinutes()} 分钟有效，过期再说「确认」会重开。`,
    ].join("\n");
  }
  const title = buyingBstock
    ? `Buy ${outLabel}`
    : `Sell ${tokenSpoken(data.tokenIn.symbol, data.tokenIn.name, false)}`;
  return [
    "Quote:",
    "",
    title,
    `- Pay: ${trimUiAmount(data.amountInUi)} ${paySym}${payNote}`,
    `- Receive: ~${trimUiAmount(data.amountOutUi)} ${getSym}`,
    `- Route: Pancake V3 (${poolIn}/${poolOut} ${poolFee})`,
    "- Slippage: 50 bps default (cap 80 bps)",
    "",
    "bStocks are certificate-style exposure, not equity, no voting rights. Off-hours the on-chain price can drift. Not investment advice.",
    `Reply 「确认」 for a signer page. Cancel with 「取消」. The page lasts ~${signerTtlMinutes()} minutes; say 「确认」 again if it expires.`,
  ].join("\n");
}

export function formatToolReply(raw: string, opts?: { zh?: boolean }): string {
  try {
    const data = JSON.parse(raw) as {
      signerUrl?: string;
      error?: string;
      message?: string;
      ok?: boolean;
      offerId?: string;
      orderId?: string;
      txHash?: string;
      artifactId?: string;
      gasWarning?: string;
      note?: string;
      blockers?: string[];
      display?: string;
      uiPrice?: string;
      token?: string;
      quote?: string;
      kind?: string;
      balances?: { token?: string; usdt?: string; bnb?: string };
      options?: Array<{
        n: number;
        action: string;
        title: string;
        note: string;
        apr24hPct?: number;
      }>;
      disclaimer?: string;
      swap?: { tokenIn?: string; tokenOut?: string; amountInUi?: string };
      lp?: { token?: string; quote?: string; budgetQuoteUi?: string; fee?: number };
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
        parkedLp?: unknown;
        decreaseBps?: number;
        burn?: boolean;
      };
      tokenIn?: QuoteTokenJson | string;
      tokenOut?: QuoteTokenJson | string;
      amountInUi?: string;
      amountOutUi?: string;
      fee?: number;
      nativeIn?: boolean;
      nativeOut?: boolean;
      hops?: Array<{ tokenIn: string; tokenOut: string; fee: number }>;
    };
    if (data.error === "risk_blocked") {
      return ["Risk check failed. No signer page was created.", ...(data.blockers ?? [])].join("\n");
    }
    if (data.error === "insufficient_balance") {
      return data.message ?? "Insufficient balance.";
    }
    if (data.error === "lp_failed" || data.error === "no_plan" || data.error === "no_swap_intent" || data.error === "no_lp" || data.error === "no_pending" || data.error === "sim_failed") {
      return data.message ?? data.error;
    }
    if (data.kind === "swap_then_lp") {
      const swap = data.swap as { tokenIn?: string; tokenOut?: string; amountInUi?: string } | undefined;
      const lp = data.lp as { token?: string; quote?: string; budgetQuoteUi?: string; fee?: number } | undefined;
      const zh = opts?.zh ?? false;
      const pay = `${swap?.amountInUi ?? "?"} ${swap?.tokenIn ?? "?"} → ~${data.amountOutUi ?? "?"} ${swap?.tokenOut ?? "?"}`;
      const mint = `${lp?.token ?? "?"}/${lp?.quote ?? "USDT"} 预算 ${lp?.budgetQuoteUi ?? "?"}${lp?.fee != null ? ` · fee ${lp.fee}` : ""}`;
      if (zh) {
        return [
          "可以，不用去交易所补 USDT。分两步，都要你自己签名：",
          "",
          `第 1 步（现在确认）：${pay}`,
          `第 2 步（兑换到账后再确认）：组 LP ${mint}，默认区间 ±30%。`,
          "",
          "风险：兑换有滑点；组 LP 有无常损失，出区间没有手续费。证书敞口不是持股。不是投资建议。",
          "回复「确认」先出第 1 步签名页。签完后会自动出第 2 步 LP 页；也可以回来说「继续」。",
        ].join("\n");
      }
      return [
        "Two signatures; you do not need to deposit the quote asset from a CEX.",
        `Step 1 (confirm now): ${pay}`,
        `Step 2 (confirm after the swap lands): mint LP ${mint}, default range ±30%.`,
        "Risks: swap slippage; LP impermanent loss. Certificate exposure is not equity. Not investment advice.",
        "Reply 「确认」 for the funding-swap signer page. After you sign it, the LP page opens; you can also say 继续.",
      ].join("\n");
    }
    if (
      !data.signerUrl &&
      data.tokenIn &&
      typeof data.tokenIn === "object" &&
      data.tokenOut &&
      typeof data.tokenOut === "object" &&
      data.amountInUi &&
      data.amountOutUi &&
      typeof data.fee === "number"
    ) {
      return formatSwapQuote(
        {
          tokenIn: data.tokenIn,
          tokenOut: data.tokenOut,
          amountInUi: data.amountInUi,
          amountOutUi: data.amountOutUi,
          fee: data.fee,
          nativeIn: data.nativeIn,
          nativeOut: data.nativeOut,
          hops: data.hops,
        },
        opts?.zh ?? false,
      );
    }
    if (data.error === "hire_not_ready") {
      return data.message ?? "Finish the Termix hire (offer + checkout + seller accept) before the signer page.";
    }
    if (data.error === "termix_not_configured" || data.error === "no_order") {
      return data.message ?? (data.error === "no_order" ? "No Termix order yet." : "Termix is not configured on this runtime.");
    }
    if (
      data.error === "delivery_needs_confirm" ||
      data.error === "hire_in_progress" ||
      data.error === "order_open" ||
      data.error === "stale_offer"
    ) {
      return data.message ?? data.error;
    }
    if (data.ok && data.offerId) {
      const fee = serviceFeeLabel();
      return [
        `Standard offer sent (${fee} service fee in Termix escrow, not a stock purchase).`,
        "Accept that card and finish checkout. I will accept the order after it is funded, then we can open a signer page.",
        `Offer ${data.offerId}.`,
      ].join("\n");
    }
    if (data.ok && data.artifactId && data.orderId) {
      return [
        `Delivery submitted for order ${data.orderId}.`,
        `Accept delivery on Termix to release the ${serviceFeeLabel()} escrow.`,
        data.txHash ? `tx ${data.txHash}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (data.ok && data.orderId && data.txHash) {
      return [
        `Order ${data.orderId} accepted. Send the whitelist token and amount (e.g. 用 0.01 USDC 买英伟达).`,
        data.gasWarning ?? "",
      ]
        .filter(Boolean)
        .join("\n");
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
    if (data.kind === "lp-propose" && Array.isArray(data.options)) {
      const zh = opts?.zh ?? true;
      const bal = data.balances;
      const head = zh
        ? [
            "按你现在的钱包给组 LP 方案（不是投资建议）：",
            bal ? `余额：${data.token ?? ""} ${bal.token} · USDT ${bal.usdt} · BNB ${bal.bnb}` : "",
            "",
          ]
        : [
            "LP options from the bound wallet (not investment advice):",
            bal ? `Balances: ${data.token ?? ""} ${bal.token} · USDT ${bal.usdt} · BNB ${bal.bnb}` : "",
            "",
          ];
      const lines = data.options.map((o) => `${o.n}. ${o.title}\n   ${o.note}`);
      const tail = zh
        ? ["", "回复数字选方案（1 / 2 / 3）。选完后回复「确认」出签名页。取消回复「取消」。", "方案里的 APR 是池子 24h 手续费，不是你的实际收益。无常损失；出区间没有手续费。"]
        : ["", "Reply with 1 / 2 / 3. Confirm after you pick. Cancel with 取消.", "Pool 24h fee APR is not your return. IL applies."];
      return [...head, ...lines, ...tail].filter(Boolean).join("\n");
    }
    if (data.kind === "lp-picked" && data.message) {
      return String(data.message);
    }
    if (data.kind === "lp-settled" && data.message) {
      return String(data.message);
    }
    if (data.display && data.uiPrice) {
      return [
        data.display,
        "This is the pool mid (how much quote asset 1 share is worth), not investment advice.",
        "To trade, state an amount, e.g. buy 100 USDT of NVIDIA / 用 100 USDT 买英伟达.",
      ].join("\n");
    }
    if (Array.isArray(data.positions)) {
      const zh = opts?.zh ?? false;
      if (!data.positions.length) {
        return zh
          ? "绑定钱包没有白名单 bStock 的 V3 仓位。要组 LP 可以说「组 LP」。"
          : "No whitelist bStock V3 positions on the bound wallet. Say 组 LP to open one.";
      }
      const lines = data.positions.map((p) => {
        const range = zh
          ? p.inRange
            ? "在区间内"
            : "已出区间，不再赚手续费"
          : p.inRange
            ? "in range"
            : "out of range, no longer earning fees";
        return [
          `#${p.tokenId} ${p.token0}/${p.token1} ${(p.fee / 10000).toFixed(2)}% · ${range}`,
          zh
            ? `仓位 ${p.amount0Ui} ${p.token0} + ${p.amount1Ui} ${p.token1} · 估值 ~$${p.markUsd}`
            : `Exposure ${p.amount0Ui} ${p.token0} + ${p.amount1Ui} ${p.token1} · mark ~$${p.markUsd}`,
          zh
            ? `未领手续费 ~$${p.feesUsdApprox} · 区间 ${p.priceLower}–${p.priceUpper}`
            : `Uncollected ~$${p.feesUsdApprox} · range ${p.priceLower}–${p.priceUpper}`,
        ].join("\n");
      });
      const outOfRange = data.positions.some((p) => !p.inRange);
      const bal = data.balances as { usdt?: string; bnb?: string } | undefined;
      const next = zh
        ? [
            bal?.usdt || bal?.bnb ? `钱包余额：USDT ${bal?.usdt ?? "?"} · BNB ${bal?.bnb ?? "?"}` : "",
            outOfRange
              ? "有仓位已出区间（不再赚手续费）。领手续费说「收手续费」；退出重开说「赎回」；加仓说「加仓 10 USDT」。然后回复「确认」。"
              : "领手续费说「收手续费」，退出说「赎回」，加仓说「加仓 10 USDT」。然后回复「确认」。",
          ].filter(Boolean)
        : [
            "Collect with 收手续费. Exit with 赎回. Add to the same NFT with 加仓 10 USDT. Then 「确认」.",
          ];
      return [
        zh
          ? `${data.count ?? data.positions.length} 个仓位（不是收益承诺）：`
          : `${data.count ?? data.positions.length} position(s) (not a yield promise):`,
        ...lines,
        ...next,
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
      const zh = opts?.zh ?? false;
      const withdrawing = s.decreaseBps != null || s.burn === true;
      const collecting = Boolean(s.tokenId && !withdrawing && !s.rangeLabel && !s.tokenIn);
      const headline = data.note
        ? data.note
        : withdrawing
          ? zh
            ? "退出仓位签名页已生成（不是投资建议）。签完流动性回到钱包。"
            : "Withdraw signer page ready (not investment advice). Liquidity returns to the wallet after you sign."
          : collecting
            ? zh
              ? "领取手续费签名页已生成（不是投资建议）。本金还在仓位里。"
              : "Collect-fees signer page ready (not investment advice). Principal stays in the position."
            : zh
          ? "签名页已生成。用绑定钱包打开，核对后签名。过期回聊天再说「确认」。"
          : "Signer page ready. Use the bound wallet. If it expires, say 「确认」 again.";
      return [
        headline,
        pair.trim(),
        zh ? `签名链接：${data.signerUrl}` : `Signer: ${data.signerUrl}`,
        s.parkedLp
          ? zh
            ? "这是两步里的第一步兑换。签完后回「签完了」或等自动出 LP 页。要停就回复「取消」。"
            : "This is step 1 of 2 (funding swap). After it lands, say 签完了 or wait for the LP page. Cancel with 取消."
          : zh
            ? "请用绑定的钱包打开。核对地址、数量和 raw。要停就回复「取消」，或在签名页点 Cancel。"
            : "Use the bound wallet. Check address, amounts, and raw before signing. To stop, say cancel / 取消, or tap Cancel on the signer page.",
        data.gasWarning ?? "",
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
    Boolean(ctx.conversation.pendingPlan) ||
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

function isHireOffer(text: string): boolean {
  return /^(?:请发(?:标准)?报价|发个(?:标准)?报价|发送(?:标准)?报价|我要这个服务|再来一单|再雇一次|雇你|开始(?:吧|合作)|可以开始了?|就这个(?:服务)?|send (?:the )?(?:standard )?offer|hire you|another hire)$/i.test(
    text.trim(),
  );
}

function isHireDeliver(text: string): boolean {
  return /^(?:请交付|交报告|提交交付|交付吧|可以交付了|做完了(?:，?请交付)?|没(?:做|有)?(?:交易|广播).{0,6}交付|deliver(?: now|y)?|submit delivery)$/i.test(
    text.trim(),
  );
}

function wantsEmptyDelivery(text: string): boolean {
  return /没(?:做|有)?(?:交易|广播).{0,8}交付|confirm empty delivery/i.test(text);
}

function isUserProceed(text: string): boolean {
  const t = text.trim();
  if (isUserCancel(t)) return false;
  if (/^(继续|下一步)[。.!！]?$/i.test(t)) return true;
  if (/(已完成|完成了|签完|签好|已经签|上链了|broadcast|signed)/i.test(t) && /(继续|下一步|continue|next|lp|组)/i.test(t)) {
    return true;
  }
  if (/^(已完成|完成了|签完了|签好了|已签名|已经签了|上链了)[了啊吧吗]?[。.!！]?$/i.test(t)) return true;
  if (/^(continue|next(?: step)?|signed|done signing|i signed|finished signing)[!.]?$/i.test(t)) return true;
  if (/继续/.test(t) && t.length <= 16 && !/(买|卖|换|加池|报价|改成)/.test(t)) return true;
  return false;
}

function parseCatalogSpeech(text: string): boolean {
  return /^(?:能买什么|可以买什么|有哪些(?:标的|票|证书)?|支持哪些|白名单|what can i (?:buy|trade))[?？]?$/i.test(
    text.trim(),
  );
}

function parseIncreaseSpeech(text: string): Extract<LocalCmd, { kind: "increase" }> | null {
  const t = text.trim();
  const m = t.match(
    /(?:加仓|补仓|往(?:这个|该)?仓位(?:里)?(?:再)?(?:打|加|补))\s*(\d+(?:\.\d+)?)\s*(u|usdt|usd|usdc|bnb|wbnb|股)?/i,
  );
  if (!m) return null;
  const amt = m[1]!;
  const unit = (m[2] ?? "usdt").toLowerCase();
  if (unit === "股") return { kind: "increase", amountTokenUi: amt };
  return { kind: "increase", amountQuoteUi: amt };
}

function parseSellDustSpeech(text: string): boolean {
  return /把(?:这些|赎回的|撤出来的|刚撤的|尘埃).{0,8}卖掉|卖掉尘埃|清掉尘埃|把赎回的卖掉/i.test(text);
}

function parseAmendSpeech(text: string): LocalCmd | null {
  const t = text.trim();
  if (/^(?:改成一半|改一半|一半金额)[。.!！]?$/i.test(t)) return { kind: "amend-half" };
  if (/^(?:再报一次|重新报价|再报个价)[。.!！]?$/i.test(t)) return { kind: "requote" };
  const withAmt = t.match(/改成(?:用)?\s*(\d+(?:\.\d+)?)\s*(usdc|usdt|usd|u|wbnb|bnb)/i);
  if (withAmt) return { kind: "amend-pay", tokenIn: spokenQuoteAsset(withAmt[2]!), amountInUi: withAmt[1]! };
  const asset = t.match(/换成\s*(usdc|usdt|usd|u|wbnb|bnb)/i);
  if (asset) return { kind: "amend-pay", tokenIn: spokenQuoteAsset(asset[1]!) };
  return null;
}

export function isUserRestart(text: string): boolean {
  const t = text.trim();
  return /全部重来|重新来|从头开始|重来一遍|start over|reset (the )?plan/i.test(t) && !isUserConfirm(t);
}

export function parseLocalCommand(text: string): LocalCmd {
  const t = text.trim();
  if (isUserCancel(t)) return { kind: "cancel" };
  if (isHireOffer(t)) return { kind: "hire-offer" };
  if (isHireDeliver(t)) return { kind: "deliver" };
  if (isUserProceed(t)) return { kind: "proceed" };
  if (isUserConfirm(t)) return { kind: "confirm" };
  const collect = parseCollectSpeech(t);
  if (collect) return collect;
  if (isDecreaseFullSpeech(t)) return { kind: "decrease", fractionBps: 10_000 };
  if (DECREASE_HALF.test(t)) return { kind: "decrease", fractionBps: 5_000 };
  if (parseCatalogSpeech(t)) return { kind: "catalog" };
  if (parseSellDustSpeech(t)) return { kind: "sell-dust" };
  const inc = parseIncreaseSpeech(t);
  if (inc) return inc;
  const amended = parseAmendSpeech(t);
  if (amended) return amended;
  if (isPositionsSpeech(t)) return { kind: "positions" };
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
  const spokenBuy = parseBuySell(t);
  if (spokenBuy && isWhitelisted(spokenBuy.tokenIn) && isWhitelisted(spokenBuy.tokenOut)) {
    return {
      kind: "quote",
      tokenIn: spokenBuy.tokenIn,
      tokenOut: spokenBuy.tokenOut,
      amountInUi: spokenBuy.amountInUi,
    };
  }
  const quote = t.match(PAIR);
  if (quote && isWhitelisted(quote[1]!) && isWhitelisted(quote[2]!)) {
    return { kind: "quote", tokenIn: quote[1]!, tokenOut: quote[2]!, amountInUi: quote[3]! };
  }
  const price = t.match(PRICE) ?? t.match(PRICE_LOOSE);
  if (price && isWhitelisted(price[1]!)) {
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

type ListedPos = {
  tokenId: string;
  token0: string;
  token1: string;
  fee?: number;
  inRange?: boolean;
  amount0Ui?: string;
  amount1Ui?: string;
  markUsd?: string;
  feesUsdApprox?: string;
};

function positionBstock(pos: { token0: string; token1: string }): string {
  for (const s of [pos.token0, pos.token1]) {
    if (!/^(USDT|USDC|WBNB|BNB)$/i.test(s)) return s;
  }
  return pos.token0;
}

function resolveTokenHint(tokenHint?: string): string | undefined {
  if (!tokenHint) return undefined;
  try {
    if (isWhitelisted(tokenHint)) return getToken(tokenHint).symbol;
  } catch {
    /* spoken name */
  }
  return findWhitelistedTokenInText(tokenHint);
}

async function pickPosition(ctx: ToolCtx, tokenId?: string, tokenHint?: string) {
  const listed = JSON.parse(await runTool("list_positions", "{}", ctx)) as { positions: ListedPos[] };
  if (tokenId) {
    const hit = listed.positions.find((p) => p.tokenId === tokenId);
    if (!hit) throw new Error(`NFT #${tokenId} 不在绑定钱包的白名单仓位里。可以说「我的仓位」核对。`);
    return hit;
  }
  const want = resolveTokenHint(tokenHint);
  const settledId = ctx.conversation.lastSettled?.kind === "lp-mint" ? ctx.conversation.lastSettled.tokenId : undefined;
  if (settledId) {
    const settledHit = listed.positions.find((p) => p.tokenId === settledId);
    if (settledHit && (!want || settledHit.token0 === want || settledHit.token1 === want)) return settledHit;
  }
  const pool = listed.positions;
  if (want) {
    const hits = pool.filter((p) => p.token0 === want || p.token1 === want);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new Error(`${hits.length} 个 ${want} 仓位。请指定 NFT 编号，例如：收手续费 ${hits[0]!.tokenId}`);
    }
    if (!hits.length) throw new Error(`绑定钱包没有 ${want} 的 LP 仓位。可以说「我的仓位」查看。`);
  }
  if (pool.length === 1) return pool[0]!;
  if (!pool.length) throw new Error("绑定钱包没有可管理的 LP 仓位。");
  throw new Error(`${pool.length} 个仓位。请指定 NFT 编号，例如：收手续费 ${pool[0]!.tokenId}`);
}

function noPendingJson(message?: string): string {
  return JSON.stringify({
    error: "no_pending",
    message:
      message ??
      "没有待执行的报价。直接说要做什么，例如：用 8 USDT 买英伟达 / 组 LP。",
  });
}

function pendingManageKind(
  lp?: PendingLp,
): "lp-collect" | "lp-decrease" | "lp-increase" | undefined {
  if (lp?.collectTokenId) return "lp-collect";
  if (lp?.decreaseTokenId) return "lp-decrease";
  if (lp?.increaseTokenId) return "lp-increase";
  return undefined;
}

async function resumePendingExecution(ctx: ToolCtx, kind: "confirm" | "proceed"): Promise<string | null> {
  const plan = ctx.conversation.pendingPlan;
  const last = ctx.conversation.lastIntent;
  const lastStored = last?.id ? ctx.intents.get(last.id) : undefined;
  const lp = ctx.conversation.lastLp;
  const wantManageKind = pendingManageKind(lp);
  const managing = Boolean(wantManageKind);

  if (
    lastStored &&
    lastStored.txHashes.length === 0 &&
    !lastStored.cancelledAt &&
    lpSignerIsReusable(lastStored) &&
    lastStored.kind !== "lp-mint" &&
    (!wantManageKind || lastStored.kind === wantManageKind)
  ) {
    return JSON.stringify({
      intentId: last!.id,
      signerUrl: last!.signerUrl,
      summary: last!.summary,
      note: "签名页已就绪",
    });
  }

  if (kind === "confirm" && managing) {
    if (
      last &&
      lastStored &&
      lastStored.txHashes.length === 0 &&
      !lastStored.cancelledAt &&
      lastStored.kind !== wantManageKind
    ) {
      try {
        ctx.intents.cancel(last.id);
      } catch {
        /* already cancelled */
      }
      const s = ctx.conversations.get(ctx.conversation.id);
      if (s.lastIntent) s.lastIntent = { ...s.lastIntent, cancelled: true };
      ctx.conversations.save(s);
      ctx.conversation = s;
    }
    return null;
  }

  if (lastStored?.kind?.startsWith("lp") && intentFilled(lastStored) && kind === "proceed" && !managing) {
    const settled = await maybeSettleLpAfterTx(ctx, lastStored);
    return JSON.stringify({
      kind: "lp-settled",
      message: settled.settledNote ?? ctx.conversation.lastSettled?.message,
      tokenId: ctx.conversation.lastSettled?.tokenId,
      pair: ctx.conversation.lastSettled?.pair,
      intentId: lastStored.id,
    });
  }

  if (kind === "proceed" && ctx.conversation.lastSettled && !plan && !managing) {
    const t = ctx.conversation.lastSettled;
    return JSON.stringify({ kind: "lp-settled", message: t.message, tokenId: t.tokenId, pair: t.pair, intentId: t.intentId });
  }

  if (last?.kind?.startsWith("lp") && !last.cancelled) {
    const intent = lastStored ?? ctx.intents.get(last.id);
    if (intent && intent.txHashes.length === 0 && !intent.cancelledAt) {
      if (lpSignerIsReusable(intent) && intent.kind !== "lp-mint") {
        return JSON.stringify({
          intentId: last.id,
          signerUrl: last.signerUrl,
          summary: last.summary,
          note: "签名页已就绪",
        });
      }
      const swapIntent = plan?.kind === "swap_then_lp" && plan.swapIntentId ? ctx.intents.get(plan.swapIntentId) : undefined;
      if (kind === "proceed" && lpSignerIsReusable(intent) && intentFilled(swapIntent)) {
        return JSON.stringify({
          intentId: last.id,
          signerUrl: last.signerUrl,
          summary: last.summary,
          note: "第二步 LP 签名页已就绪",
        });
      }
      if (intent.kind !== "lp-mint") return null;
      try {
        ctx.intents.cancel(last.id);
      } catch {
        /* already cancelled */
      }
      const s = ctx.conversations.get(ctx.conversation.id);
      if (s.lastIntent) s.lastIntent = { ...s.lastIntent, cancelled: true };
      if (s.lastLp && !s.lastLp.committed && !managing) delete s.lastLp;
      ctx.conversations.save(s);
      ctx.conversation = s;
      if (plan?.kind === "swap_then_lp" && intentFilled(swapIntent)) {
        const continued = await continueSwapThenLp(ctx);
        if (continued.error === "insufficient_balance" || continued.error === "sim_failed") {
          return runTool("propose_lp", JSON.stringify({ token: plan.lp.token }), ctx);
        }
        if (continued.signerUrl || continued.error) return JSON.stringify(continued);
      }
      if (plan?.kind === "swap_then_lp" && !intentFilled(swapIntent)) return null;
      return noPendingJson();
    }
  }

  const prop = ctx.conversation.lastLpProposal;
  if (kind === "confirm" && prop?.options?.length && prop.selected == null && !managing) {
    return noPendingJson();
  }

  if (plan?.kind === "swap_then_lp" && plan.swapIntentId) {
    const swapIntent = ctx.intents.get(plan.swapIntentId);
    if (intentFilled(swapIntent)) {
      const continued = await continueSwapThenLp(ctx);
      if (continued.error === "insufficient_balance" || continued.error === "sim_failed") {
        return runTool("propose_lp", JSON.stringify({ token: plan.lp.token }), ctx);
      }
      return JSON.stringify(continued);
    }
    return null;
  }
  if (kind === "proceed" && last?.kind === "swap" && !last.cancelled) {
    const intent = ctx.intents.get(last.id);
    return JSON.stringify(await continueSwapThenLp(ctx, intent));
  }
  return null;
}

export async function runLocalCommand(text: string, ctx: ToolCtx): Promise<string | null> {
  if (text !== "确认执行") {
    const fromPick = await applyLpPickFromText(ctx, text);
    if (fromPick) return fromPick;
  }
  const cmd = parseLocalCommand(text);
  if (cmd.kind === "none") return null;

  if (cmd.kind === "cancel") {
    return cancelPendingTrade(ctx);
  }

  if (cmd.kind === "confirm" || cmd.kind === "proceed") {
    ctx.conversation.userConfirmed = true;
    ctx.conversations.save(ctx.conversation);
    const resumed = await resumePendingExecution(ctx, cmd.kind);
    if (resumed) return resumed;
  }

  if (cmd.kind === "hire-offer") {
    ctx.conversation.userConfirmed = true;
    return runTool("send_termix_offer", "{}", ctx);
  }

  if (cmd.kind === "deliver") {
    const confirmEmpty = Boolean(ctx.conversation.pendingEmptyDelivery) || wantsEmptyDelivery(text);
    const raw = await runTool("submit_termix_delivery", JSON.stringify({ confirmEmpty }), ctx);
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error === "delivery_needs_confirm") {
        const s = ctx.conversations.get(ctx.conversation.id);
        s.pendingEmptyDelivery = true;
        ctx.conversations.save(s);
        ctx.conversation.pendingEmptyDelivery = true;
      }
    } catch {
      /* plain */
    }
    return raw;
  }

  if (cmd.kind === "price") {
    return runTool("get_bstock_price", JSON.stringify({ token: cmd.token, quote: cmd.quote }), ctx);
  }

  if (cmd.kind === "positions") {
    return runTool("list_positions", "{}", ctx);
  }

  if (cmd.kind === "collect") {
    const pos = await pickPosition(ctx, cmd.tokenId, findWhitelistedTokenInText(text));
    rememberLp(ctx, { token: positionBstock(pos), collectTokenId: pos.tokenId });
    const zh = /[\u4e00-\u9fff]/.test(text);
    const fees = pos.feesUsdApprox ? `未领手续费约 $${pos.feesUsdApprox}` : "";
    if (zh) {
      return [
        `将领取 NFT #${pos.tokenId}（${pos.token0}/${pos.token1}）的手续费。本金不动。${fees}`.trim(),
        "核对后回复「确认」出签名页。",
      ].join("\n");
    }
    return [
      `Will collect fees from NFT #${pos.tokenId} (${pos.token0}/${pos.token1}). Principal stays.`,
      "Reply 「确认」 after you check.",
    ].join("\n");
  }

  if (cmd.kind === "decrease") {
    const pos = await pickPosition(ctx, undefined, findWhitelistedTokenInText(text));
    rememberLp(ctx, { token: positionBstock(pos), decreaseTokenId: pos.tokenId, decreaseBps: cmd.fractionBps });
    const zh = /[\u4e00-\u9fff]/.test(text);
    const all = cmd.fractionBps >= 10_000;
    const amounts =
      pos.amount0Ui && pos.amount1Ui ? `约 ${pos.amount0Ui} ${pos.token0} + ${pos.amount1Ui} ${pos.token1}` : "";
    if (zh) {
      const label = all ? "退出全部流动性并销毁 NFT" : "撤出一半流动性";
      return [
        `将${label}：NFT #${pos.tokenId}（${pos.token0}/${pos.token1}）${amounts ? `，${amounts} 回到钱包` : ""}。手续费一并领取。`,
        "按当下池价结算，实际到账以链上为准。核对后回复「确认」出签名页。",
      ].join("\n");
    }
    const label = all ? "withdraw all (and burn the NFT)" : "withdraw half the liquidity";
    return [`Will ${label}: NFT #${pos.tokenId} (${pos.token0}/${pos.token1}).`, "Reply 「确认」 after you check."].join("\n");
  }

  if (cmd.kind === "increase") {
    const pos = await pickPosition(ctx, undefined, findWhitelistedTokenInText(text));
    rememberLp(ctx, {
      token: positionBstock(pos),
      increaseTokenId: pos.tokenId,
      amountTokenUi: cmd.amountTokenUi,
      amountQuoteUi: cmd.amountQuoteUi,
    });
    const quoteAmt = cmd.amountQuoteUi ? `${cmd.amountQuoteUi} USDT` : `${cmd.amountTokenUi} ${positionBstock(pos)}`;
    return [
      `将加仓 NFT #${pos.tokenId}（${pos.token0}/${pos.token1}）：约 ${quoteAmt}。不会新开第二个仓位。`,
      "核对后回复「确认」出签名页。",
    ].join("\n");
  }

  if (cmd.kind === "catalog") {
    const rows = listTokens().filter((t) => t.kind === "bstock");
    const lines = rows.map((t) => {
      const aka = aliasesFor(t.symbol).filter((a) => a !== t.symbol).slice(0, 4);
      return `- ${t.symbol}（${t.name.replace(/\s*\(bStocks\)\s*/i, "")}${aka.length ? ` / ${aka.join("、")}` : ""}）`;
    });
    return ["能买的白名单证书（BSC / Pancake V3）：", ...lines, "", "直接说金额，例如：用 10 USDT 买英伟达。不是投资建议。"].join("\n");
  }

  if (cmd.kind === "sell-dust") {
    const pair = ctx.conversation.lastSettled?.kind === "lp-decrease" ? ctx.conversation.lastSettled.pair : undefined;
    const token = pair?.split("/").find((p) => !/^(USDT|USDC|WBNB|BNB)$/i.test(p));
    if (!token) {
      return JSON.stringify({
        error: "no_pending",
        message: "没有刚赎回的仓位可清。先说「赎回」并签完，或直接说「全部 NVDAB 卖掉」。",
      });
    }
    const filled = await fillAllAmount(ctx, { tokenIn: token, tokenOut: "USDT", amountInUi: "all" });
    rememberSwapQuote(ctx, filled);
    return runTool(
      "quote_swap",
      JSON.stringify({ tokenIn: filled.tokenIn, tokenOut: filled.tokenOut, amountInUi: filled.amountInUi }),
      ctx,
    );
  }

  if (cmd.kind === "amend-half" || cmd.kind === "amend-pay" || cmd.kind === "requote") {
    const cur = ctx.conversation.lastQuote;
    if (!cur) {
      return JSON.stringify({ error: "no_pending", message: "没有待改的报价。先说要买/卖多少，例如：用 10 USDT 买英伟达。" });
    }
    let next = { ...cur };
    if (cmd.kind === "amend-half") {
      const n = Number(cur.amountInUi);
      if (!Number.isFinite(n) || n <= 0) {
        return JSON.stringify({ error: "no_pending", message: "当前报价金额没法减半。请直接说新的数量。" });
      }
      next = { ...cur, amountInUi: String(n / 2) };
    } else if (cmd.kind === "amend-pay") {
      if (!cmd.amountInUi && /^(BNB|WBNB)$/i.test(cmd.tokenIn) && !/^(BNB|WBNB)$/i.test(cur.tokenIn)) {
        return JSON.stringify({
          error: "no_pending",
          message: `换成 ${cmd.tokenIn} 需要新的数量。例如：改成用 0.01 BNB。`,
        });
      }
      next = {
        tokenIn: cmd.tokenIn,
        tokenOut: cur.tokenOut,
        amountInUi: cmd.amountInUi ?? cur.amountInUi,
      };
    }
    const filled = await fillAllAmount(ctx, next);
    rememberSwapQuote(ctx, filled);
    return runTool(
      "quote_swap",
      JSON.stringify({ tokenIn: filled.tokenIn, tokenOut: filled.tokenOut, amountInUi: filled.amountInUi }),
      ctx,
    );
  }

  if (cmd.kind === "quote") {
    const filled = await fillAllAmount(ctx, {
      tokenIn: cmd.tokenIn,
      tokenOut: cmd.tokenOut,
      amountInUi: cmd.amountInUi,
    });
    if (wantsLpAfterTrade(text)) {
      try {
        const token = getToken(filled.tokenOut).symbol;
        ctx.conversation.lastLp = { token, quote: "USDT", rangeBps: DEFAULT_LP_RANGE_BPS };
      } catch {
        /* tokenOut not a bstock */
      }
    }
    rememberSwapQuote(ctx, filled);
    const quoted = await runTool(
      "quote_swap",
      JSON.stringify({ tokenIn: filled.tokenIn, tokenOut: filled.tokenOut, amountInUi: filled.amountInUi }),
      ctx,
    );
    return quoted;
  }

  if (cmd.kind === "lp-compare") {
    return runTool("compare_lp_pools", JSON.stringify({ token: cmd.token }), ctx);
  }

  if (cmd.kind === "lp") {
    if (!hasMintSize(cmd) && !cmd.pick && !/分析|analyze/i.test(text)) {
      const token = cmd.token || ctx.conversation.lastLpCompare?.token || ctx.conversation.lastLp?.token || "NVDAB";
      return runTool("propose_lp", JSON.stringify({ token: token || "NVDAB" }), ctx);
    }
    const selected = await resolveLpPool(ctx, cmd);
    rememberLp(ctx, {
      token: selected.token,
      quote: selected.quote,
      fee: selected.fee,
      amountTokenUi: cmd.amountTokenUi,
      amountQuoteUi: cmd.amountQuoteUi,
      budgetQuoteUi: cmd.budgetQuoteUi,
      rangeBps: DEFAULT_LP_RANGE_BPS,
      committed: hasMintSize(cmd),
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
      `Noted LP mint: ${size} · ${pool}, default range ±30%. Reply 「确认」 to get a signer page. ${apr}`,
    ].join("\n");
  }

  const managingNow = Boolean(pendingManageKind(ctx.conversation.lastLp));
  const step = managingNow ? "none" : nextConfirmKind(ctx.conversation);
  if (step === "swap") {
    const q =
      ctx.conversation.pendingPlan?.kind === "swap_then_lp"
        ? ctx.conversation.pendingPlan.swap
        : ctx.conversation.lastQuote;
    if (q) {
      return runTool(
        "create_swap_intent",
        JSON.stringify({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountInUi: q.amountInUi }),
        ctx,
      );
    }
  }
  if (step === "lp" && ctx.conversation.lastLp) {
    const pending = ctx.conversation.lastLp;
    const swapIntent =
      ctx.conversation.pendingPlan?.kind === "swap_then_lp" && ctx.conversation.pendingPlan.swapIntentId
        ? ctx.intents.get(ctx.conversation.pendingPlan.swapIntentId)
        : undefined;
    if (pending.committed || ctx.conversation.lastLpProposal?.selected != null || intentFilled(swapIntent)) {
      if (!hasMintSize(pending) && ctx.conversation.lastLpProposal?.selected == null) {
        return runTool("propose_lp", JSON.stringify({ token: pending.token }), ctx);
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
        }),
        ctx,
      );
    }
    return noPendingJson();
  }

  const lp = ctx.conversation.lastLp;
  const picked = ctx.conversation.lastLpProposal?.selected != null;
  const mintReady = Boolean(hasMintSize(lp) && (lp?.committed || picked));
  const pending =
    lp?.collectTokenId || lp?.decreaseTokenId || lp?.increaseTokenId || mintReady
      ? { type: "lp" as const, ...lp }
      : ctx.conversation.lastQuote
        ? { type: "swap" as const, ...ctx.conversation.lastQuote }
        : null;
  if (!pending) {
    return noPendingJson();
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
