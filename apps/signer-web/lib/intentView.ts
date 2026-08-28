import type { RemoteIntent } from "./runtime";

const NAMES: Record<string, string> = {
  NVDAB: "NVIDIA",
  TSLAB: "Tesla",
  CRCLB: "Circle",
  MUB: "Micron",
  SNDKB: "SanDisk",
  SPCXB: "SpaceX",
  AMDB: "AMD",
  EWYB: "Korea ETF",
  INTCB: "Intel",
  MSTRB: "MicroStrategy",
  LITEB: "Lumentum",
  METAB: "Meta",
  MSFTB: "Microsoft",
  PLTRB: "Palantir",
  QQQB: "Nasdaq-100",
  USDT: "USDT",
  USDC: "USDC",
  WBNB: "WBNB",
  BNB: "native BNB",
};

const KIND_TITLE: Record<string, string> = {
  swap: "Confirm swap",
  "lp-mint": "Confirm add liquidity",
  "lp-increase": "Confirm increase",
  "lp-decrease": "Confirm withdraw",
  "lp-collect": "Confirm collect fees",
  approve: "Confirm approve",
};

const KIND_CTA: Record<string, string> = {
  swap: "Confirm swap",
  "lp-mint": "Confirm mint",
  "lp-increase": "Confirm increase",
  "lp-decrease": "Confirm withdraw",
  "lp-collect": "Confirm collect",
  approve: "Confirm approve",
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
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, text: "Expired. Go back to chat for a new quote." };
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return { expired: false, text: mins < 60 ? `Valid for ${mins} min` : `Valid for ${Math.floor(mins / 60)} h` };
}

export function txTitle(label: string): string {
  if (/approve/i.test(label)) return "Approve";
  if (/wrap/i.test(label)) return "Wrap BNB";
  if (/unwrap/i.test(label)) return "Unwrap BNB";
  if (/swap/i.test(label)) return "Swap";
  if (/increase/i.test(label)) return "Increase";
  if (/decrease|withdraw/i.test(label)) return "Withdraw";
  if (/mint/i.test(label)) return "Add liquidity";
  if (/collect/i.test(label)) return "Collect fees";
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
      footnote: "Certificate ≠ stock. Settlement is whatever the chain fills.",
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
      payAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "both sides",
      paySymbol: `${t0} + ${t1}`,
      payName: [tokenName(t0), tokenName(t1)].filter(Boolean).join(" / ") || undefined,
      getAmount: str(s, "rangeLabel") ?? "V3 LP",
      getSymbol: intent.kind === "lp-increase" ? `Position #${str(s, "tokenId") ?? ""}` : "Position NFT",
      detail: [range, Number.isFinite(fee) ? `fee ${(fee / 10000).toFixed(2)}%` : undefined]
        .filter(Boolean)
        .join(" · "),
      footnote: "LP can incur IL. Out of range earns no fees. Sizes use the V3 range formula, not a 50/50 spot split.",
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
      payAmount: str(s, "tokenId") ? `#${str(s, "tokenId")}` : "Position",
      paySymbol: s.burn ? "Withdraw and burn NFT" : "Partial withdraw",
      getAmount: a0 && a1 ? `${formatUi(a0, 4)} + ${formatUi(a1, 4)}` : "principal + fees",
      getSymbol: `${t0} + ${t1}`,
      footnote: "Withdraw returns in-range principal and uncollected fees.",
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
      paySymbol: "Principal stays",
      getAmount: a0 && a1 ? `${formatUi(a0, 6)} + ${formatUi(a1, 6)}` : "fees",
      getSymbol: t0 && t1 ? `${t0} + ${t1}` : "pool tokens",
      detail: str(s, "tokenId") ? `NFT #${str(s, "tokenId")}` : undefined,
      footnote: "Collects fees only. Principal is not withdrawn.",
    };
  }

  return {
    title: KIND_TITLE[intent.kind] ?? "Confirm signature",
    cta: KIND_CTA[intent.kind] ?? "Confirm and sign",
    payAmount: amountIn ? formatUi(amountIn) : "—",
    paySymbol: tokenIn ?? "",
    getAmount: amountOut ? formatUi(amountOut) : "—",
    getSymbol: tokenOut ?? "",
    footnote: "Check the network and amounts in the wallet popup.",
  };
}
