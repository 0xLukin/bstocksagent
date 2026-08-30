import type { RemoteIntent } from "./runtime";

const NAMES: Record<string, string> = {
  NVDAB: "英伟达",
  TSLAB: "特斯拉",
  CRCLB: "Circle",
  MUB: "美光",
  SNDKB: "闪迪",
  SPCXB: "SpaceX",
  AMDB: "AMD",
  EWYB: "韩国 ETF",
  INTCB: "英特尔",
  MSTRB: "MicroStrategy",
  LITEB: "Lumentum",
  METAB: "Meta",
  MSFTB: "微软",
  PLTRB: "Palantir",
  QQQB: "纳斯达克 100",
  USDT: "USDT",
  USDC: "USDC",
  WBNB: "WBNB",
};

export type TicketKind = "swap" | "lp-mint" | "lp-increase" | "lp-decrease" | "lp-collect" | "other";

export type IntentView = {
  kind: TicketKind;
  eyebrow: string;
  title: string;
  cta: string;
  payLabel: string;
  getLabel: string;
  payAmount: string;
  paySymbol: string;
  payName?: string;
  getAmount: string;
  getSymbol: string;
  getName?: string;
  minGet?: string;
  slippage?: string;
  detail?: string;
  footnote: string;
  twoStep: boolean;
  stepLabel?: string;
  doneTitle: string;
  doneBody: string;
  donePayLabel: string;
  doneGetLabel: string;
  /** LP two-sided amounts for clear result / quote display */
  side0?: { amount: string; symbol: string; name?: string };
  side1?: { amount: string; symbol: string; name?: string };
  nftId?: string;
  rangeLabel?: string;
  feeLabel?: string;
};

export function tokenName(symbol: string): string | undefined {
  return NAMES[symbol.toUpperCase()];
}

export function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatUi(value: string, maxFrac = 6): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 });
}

export function remainingLabel(iso: string): { expired: boolean; text: string } {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, text: "已过期" };
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return { expired: false, text: mins < 60 ? `${mins} 分钟` : `${Math.floor(mins / 60)} 小时` };
}

export function txTitle(label: string): string {
  if (/approve/i.test(label)) return "授权";
  if (/wrap/i.test(label)) return "包装";
  if (/unwrap/i.test(label)) return "解包";
  if (/swap/i.test(label)) return "兑换";
  if (/increase/i.test(label)) return "加仓";
  if (/decrease|withdraw/i.test(label)) return "减仓";
  if (/mint/i.test(label)) return "组 LP";
  if (/collect/i.test(label)) return "领费";
  return label;
}

type ParkedLp = {
  token?: string;
  quote?: string;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  committed?: boolean;
  fee?: number;
};

function parkedLpOf(intent: RemoteIntent): ParkedLp | undefined {
  const raw = intent.summary.parkedLp;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ParkedLp;
}

/** True only when this swap is actually step 1 of minting LP, not a leftover park from another chat. */
export function wantsLpFollowUp(intent: RemoteIntent): boolean {
  if (intent.kind !== "swap") return false;
  const lp = parkedLpOf(intent);
  if (!lp?.token) return false;
  const tin = String(intent.summary.tokenIn ?? "").toUpperCase();
  const tout = String(intent.summary.tokenOut ?? "").toUpperCase();
  const quote = (lp.quote ?? "USDT").toUpperCase();
  const fundingQuote = tout === quote || tout === "USDT" || tout === "USDC" || tout === "WBNB" || tout === "BNB";
  if ((tin === "BNB" || tin === "WBNB") && fundingQuote && tout !== String(lp.token).toUpperCase()) {
    return true;
  }
  if (tout !== String(lp.token).toUpperCase()) return false;
  return Boolean(lp.committed || lp.amountTokenUi || lp.amountQuoteUi || lp.budgetQuoteUi || lp.fee == null);
}

function str(summary: Record<string, unknown>, key: string): string | undefined {
  const v = summary[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function minGetUi(summary: Record<string, unknown>): string | undefined {
  const outUi = str(summary, "amountOutUi");
  const bps = Number(summary.slippageBps);
  if (!outUi || !Number.isFinite(bps)) return undefined;
  return formatUi(String(Number(outUi) * (1 - bps / 10_000)));
}

function spoken(symbol: string): string {
  const name = tokenName(symbol);
  return name && name !== symbol ? `${symbol}（${name}）` : symbol;
}

export function buildIntentView(intent: RemoteIntent): IntentView {
  const s = intent.summary;
  const tokenIn = str(s, "tokenIn");
  const tokenOut = str(s, "tokenOut");
  const amountIn = str(s, "amountInUi");
  const amountOut = str(s, "amountOutUi");
  const analysis = s.analysis as { token0?: string; token1?: string } | undefined;
  const twoStep = wantsLpFollowUp(intent);

  if (intent.kind === "swap" && tokenIn && tokenOut && amountIn && amountOut) {
    const slip = Number(s.slippageBps);
    const buying = !/^(USDT|USDC|BNB|WBNB)$/i.test(tokenOut);
    const eyebrow = twoStep ? "买入 · 1 / 2" : buying ? "买入" : "卖出";
    const title = buying ? `买 ${spoken(tokenOut)}` : `卖 ${spoken(tokenIn)}`;
    return {
      kind: "swap",
      eyebrow,
      title,
      cta: "确认签名",
      payLabel: "支付",
      getLabel: "预计到账",
      payAmount: formatUi(amountIn, 4),
      paySymbol: tokenIn,
      payName: tokenIn === "BNB" ? "BNB" : tokenName(tokenIn),
      getAmount: formatUi(amountOut),
      getSymbol: tokenOut,
      getName: tokenName(tokenOut),
      minGet: minGetUi(s),
      slippage: Number.isFinite(slip) ? `${(slip / 100).toFixed(2)}%` : undefined,
      footnote: "",
      twoStep,
      stepLabel: twoStep ? "先完成兑换，组 LP 会另开一页。" : undefined,
      doneTitle: buying ? `${spoken(tokenOut)} 已到账` : `${spoken(tokenIn)} 已卖出`,
      doneBody: twoStep ? "兑换已完成，可继续组 LP。" : "",
      donePayLabel: "已支付",
      doneGetLabel: "已到账",
    };
  }

  if (intent.kind === "lp-mint" || intent.kind === "lp-increase") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const range = str(s, "rangeLabel") ?? str(s, "rangePrices");
    const fee = Number(s.fee);
    const increase = intent.kind === "lp-increase";
    const tokenId = str(s, "tokenId");
    const feeLabel = Number.isFinite(fee) ? `${(fee / 10000).toFixed(2)}%` : undefined;
    return {
      kind: increase ? "lp-increase" : "lp-mint",
      eyebrow: increase ? "加仓" : "组 LP",
      title: increase ? `加仓 #${tokenId ?? ""}` : `${spoken(t0)} / ${spoken(t1)}`,
      cta: "确认签名",
      payLabel: "放入池子",
      getLabel: increase ? "加到" : "开仓",
      payAmount: a0 && a1 ? `${formatUi(a0, 4)}` : "—",
      paySymbol: t0,
      payName: tokenName(t0),
      getAmount: a1 ? formatUi(a1, 4) : range ?? "—",
      getSymbol: t1,
      getName: tokenName(t1),
      detail: undefined,
      footnote: "",
      twoStep: false,
      doneTitle: increase ? `已加进 #${tokenId ?? ""}` : `${spoken(t0)} / ${spoken(t1)} 已开仓`,
      doneBody: "",
      donePayLabel: "已放入",
      doneGetLabel: "已放入",
      side0: a0 ? { amount: formatUi(a0, 4), symbol: t0, name: tokenName(t0) } : undefined,
      side1: a1 ? { amount: formatUi(a1, 4), symbol: t1, name: tokenName(t1) } : undefined,
      nftId: tokenId ? `#${tokenId}` : undefined,
      rangeLabel: range,
      feeLabel,
    };
  }

  if (intent.kind === "lp-decrease") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const tokenId = str(s, "tokenId");
    const burn = Boolean(s.burn);
    return {
      kind: "lp-decrease",
      eyebrow: burn ? "赎回" : "减仓",
      title: burn ? `赎回 #${tokenId ?? ""}` : `减仓 #${tokenId ?? ""}`,
      cta: "确认签名",
      payLabel: "退出",
      getLabel: "预计到账",
      payAmount: tokenId ? `#${tokenId}` : "仓位",
      paySymbol: burn ? "将销毁" : "保留",
      getAmount: a0 ? formatUi(a0, 4) : "—",
      getSymbol: t0,
      getName: tokenName(t0),
      footnote: "",
      twoStep: false,
      doneTitle: burn ? `#${tokenId ?? ""} 已赎回` : `#${tokenId ?? ""} 已减仓`,
      doneBody: "",
      donePayLabel: "已退出",
      doneGetLabel: "已到账",
      side0: a0 ? { amount: formatUi(a0, 4), symbol: t0, name: tokenName(t0) } : undefined,
      side1: a1 ? { amount: formatUi(a1, 4), symbol: t1, name: tokenName(t1) } : undefined,
      nftId: tokenId ? `#${tokenId}` : undefined,
    };
  }

  if (intent.kind === "lp-collect") {
    const t0 = str(s, "token0") ?? analysis?.token0;
    const t1 = str(s, "token1") ?? analysis?.token1;
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const tokenId = str(s, "tokenId");
    return {
      kind: "lp-collect",
      eyebrow: "领费",
      title: `领费 #${tokenId ?? ""}`,
      cta: "确认签名",
      payLabel: "本金",
      getLabel: "预计领取",
      payAmount: "不动",
      paySymbol: "留在池里",
      getAmount: a0 && t0 ? formatUi(a0, 6) : "—",
      getSymbol: t0 ?? "",
      getName: t0 ? tokenName(t0) : undefined,
      detail: undefined,
      footnote: "",
      twoStep: false,
      doneTitle: `#${tokenId ?? ""} 手续费已到账`,
      doneBody: "",
      donePayLabel: "本金未动",
      doneGetLabel: "已领取",
      side0: a0 && t0 ? { amount: formatUi(a0, 6), symbol: t0, name: tokenName(t0) } : undefined,
      side1: a1 && t1 ? { amount: formatUi(a1, 6), symbol: t1, name: tokenName(t1) } : undefined,
      nftId: tokenId ? `#${tokenId}` : undefined,
    };
  }

  return {
    kind: "other",
    eyebrow: "签名",
    title: "确认这笔调用",
    cta: "确认签名",
    payLabel: "支付",
    getLabel: "预计到账",
    payAmount: amountIn ? formatUi(amountIn) : "—",
    paySymbol: tokenIn ?? "",
    getAmount: amountOut ? formatUi(amountOut) : "—",
    getSymbol: tokenOut ?? "",
    footnote: "",
    twoStep: false,
    doneTitle: "已上链",
    doneBody: "",
    donePayLabel: "已支付",
    doneGetLabel: "已到账",
  };
}
