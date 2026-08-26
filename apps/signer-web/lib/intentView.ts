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
  MSTRB: "微策略",
  LITEB: "Lumentum",
  METAB: "Meta",
  MSFTB: "微软",
  PLTRB: "Palantir",
  QQQB: "纳指",
  USDT: "USDT",
  USDC: "USDC",
  WBNB: "WBNB",
  BNB: "原生 BNB",
};

const KIND_TITLE: Record<string, string> = {
  swap: "确认兑换",
  "lp-mint": "确认添加流动性",
  "lp-increase": "确认加仓",
  "lp-decrease": "确认撤出",
  "lp-collect": "确认收取手续费",
  approve: "确认授权",
};

const KIND_CTA: Record<string, string> = {
  swap: "确认兑换",
  "lp-mint": "确认加池",
  "lp-increase": "确认加仓",
  "lp-decrease": "确认撤出",
  "lp-collect": "确认收取",
  approve: "确认授权",
};

export type IntentView = {
  title: string;
  cta: string;
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
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, text: "已过期，请回对话重新报价" };
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return { expired: false, text: mins < 60 ? `${mins} 分钟内有效` : `${Math.floor(mins / 60)} 小时内有效` };
}

export function txTitle(label: string): string {
  if (/approve/i.test(label)) return "授权";
  if (/wrap/i.test(label)) return "包装 BNB";
  if (/unwrap/i.test(label)) return "解包 BNB";
  if (/swap/i.test(label)) return "兑换";
  if (/increase/i.test(label)) return "加仓";
  if (/decrease|withdraw/i.test(label)) return "撤出";
  if (/mint/i.test(label)) return "添加流动性";
  if (/collect/i.test(label)) return "收取手续费";
  return label;
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

export function buildIntentView(intent: RemoteIntent): IntentView {
  const s = intent.summary;
  const tokenIn = str(s, "tokenIn");
  const tokenOut = str(s, "tokenOut");
  const amountIn = str(s, "amountInUi");
  const amountOut = str(s, "amountOutUi");
  const analysis = s.analysis as { token0?: string; token1?: string } | undefined;

  if (intent.kind === "swap" && tokenIn && tokenOut && amountIn && amountOut) {
    const slip = Number(s.slippageBps);
    return {
      title: KIND_TITLE.swap,
      cta: KIND_CTA.swap,
      payAmount: formatUi(amountIn, 4),
      paySymbol: tokenIn,
      payName: tokenName(tokenIn),
      getAmount: formatUi(amountOut),
      getSymbol: tokenOut,
      getName: tokenName(tokenOut),
      minGet: minGetUi(s),
      slippage: Number.isFinite(slip) ? `${(slip / 100).toFixed(2)}%` : undefined,
      footnote: "证书 ≠ 股票，成交以链上为准。",
    };
  }

  if (intent.kind === "lp-mint" || intent.kind === "lp-increase") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    const range = str(s, "rangePrices") ?? str(s, "rangeLabel");
    const fee = Number(s.fee);
    return {
      title: KIND_TITLE[intent.kind],
      cta: KIND_CTA[intent.kind],
      payAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "双边",
      paySymbol: `${t0} + ${t1}`,
      payName: [tokenName(t0), tokenName(t1)].filter(Boolean).join(" / ") || undefined,
      getAmount: str(s, "rangeLabel") ?? "V3 LP",
      getSymbol: intent.kind === "lp-increase" ? `仓位 #${str(s, "tokenId") ?? ""}` : "仓位 NFT",
      detail: [range, Number.isFinite(fee) ? `fee ${(fee / 10000).toFixed(2)}%` : undefined]
        .filter(Boolean)
        .join(" · "),
      footnote: "LP 有无常损失，区间外不再吃手续费。数量按 V3 区间公式，不是现货对半。",
    };
  }

  if (intent.kind === "lp-decrease") {
    const t0 = str(s, "token0") ?? analysis?.token0 ?? "token0";
    const t1 = str(s, "token1") ?? analysis?.token1 ?? "token1";
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    return {
      title: KIND_TITLE["lp-decrease"],
      cta: KIND_CTA["lp-decrease"],
      payAmount: str(s, "tokenId") ? `#${str(s, "tokenId")}` : "仓位",
      paySymbol: s.burn ? "撤出并销毁 NFT" : "部分撤出",
      getAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "本金+费用",
      getSymbol: `${t0} + ${t1}`,
      footnote: "撤出会取回区间内本金和未收手续费。",
    };
  }

  if (intent.kind === "lp-collect") {
    const t0 = str(s, "token0") ?? analysis?.token0;
    const t1 = str(s, "token1") ?? analysis?.token1;
    const a0 = str(s, "amount0Ui");
    const a1 = str(s, "amount1Ui");
    return {
      title: KIND_TITLE["lp-collect"],
      cta: KIND_CTA["lp-collect"],
      payAmount: "—",
      paySymbol: "本金不动",
      getAmount: a0 && a1 ? `${formatUi(a0, 6)} + ${formatUi(a1, 6)}` : "手续费",
      getSymbol: t0 && t1 ? `${t0} + ${t1}` : "池内代币",
      detail: str(s, "tokenId") ? `NFT #${str(s, "tokenId")}` : undefined,
      footnote: "只收手续费，不会撤出本金。",
    };
  }

  return {
    title: KIND_TITLE[intent.kind] ?? "确认签名",
    cta: KIND_CTA[intent.kind] ?? "确认并签名",
    payAmount: amountIn ? formatUi(amountIn) : "—",
    paySymbol: tokenIn ?? "",
    getAmount: amountOut ? formatUi(amountOut) : "—",
    getSymbol: tokenOut ?? "",
    footnote: "请核对钱包弹窗里的网络和金额。",
  };
}
