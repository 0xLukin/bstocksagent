import type { TokenRecord } from "./types.js";
import { amount1FromAmount0 } from "./lp-math.js";

export const DEFAULT_LP_RANGE_BPS = 3000;

export function parseUiNumber(ui: string | number | undefined): number {
  if (ui === undefined) return 0;
  const n = typeof ui === "number" ? ui : Number(ui);
  return Number.isFinite(n) ? n : 0;
}

/** token1 per 1 whole token0, from sqrtPriceX96. */
export function token1PerToken0(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const one0 = 10n ** BigInt(decimals0);
  const raw1 = amount1FromAmount0(one0, sqrtPriceX96);
  return Number(raw1) / 10 ** decimals1;
}

export function quotePerToken(args: {
  token: TokenRecord;
  quote: TokenRecord;
  token0: TokenRecord;
  token1: TokenRecord;
  sqrtPriceX96: bigint;
}): number {
  const p = token1PerToken0(args.sqrtPriceX96, args.token0.decimals, args.token1.decimals);
  if (!(p > 0)) return 0;
  const tokenIs0 = args.token.address.toLowerCase() === args.token0.address.toLowerCase();
  if (args.quote.address.toLowerCase() === args.token1.address.toLowerCase() && tokenIs0) return p;
  if (args.quote.address.toLowerCase() === args.token0.address.toLowerCase() && !tokenIs0) {
    return 1 / p;
  }
  if (args.quote.address.toLowerCase() === args.token0.address.toLowerCase() && tokenIs0) return 1 / p;
  if (args.quote.address.toLowerCase() === args.token1.address.toLowerCase() && !tokenIs0) return p;
  return 0;
}

export function markPairUsd(args: {
  token0: TokenRecord;
  token1: TokenRecord;
  amount0Ui: string;
  amount1Ui: string;
  sqrtPriceX96: bigint;
  /** USD per 1 WBNB. Required to mark gas/bStock pools; without it WBNB is treated as $1. */
  usdPerGas?: number;
}): number {
  const a0 = parseUiNumber(args.amount0Ui);
  const a1 = parseUiNumber(args.amount1Ui);
  const p = token1PerToken0(args.sqrtPriceX96, args.token0.decimals, args.token1.decimals);
  if (args.token1.kind === "stable") return a0 * p + a1;
  if (args.token0.kind === "stable") return a0 + (p > 0 ? a1 / p : 0);
  const g = args.usdPerGas;
  if (g && g > 0) {
    if (args.token1.kind === "gas") return (a0 * p + a1) * g;
    if (args.token0.kind === "gas") return a0 * g + (p > 0 ? (a1 / p) * g : 0);
  }
  return a0 * p + a1;
}

/** USDT (or stable) notional for a swap. Selling a bStock uses mid × shares. */
export function swapNotionalUsd(args: {
  tokenIn: TokenRecord;
  tokenOut: TokenRecord;
  amountInUi: string;
  amountOutUi?: string;
  midQuotePerUnit?: number;
}): number {
  if (args.tokenIn.kind === "stable") return parseUiNumber(args.amountInUi);
  const mid =
    args.midQuotePerUnit && args.midQuotePerUnit > 0
      ? args.midQuotePerUnit
      : args.tokenOut.kind === "stable" && parseUiNumber(args.amountInUi) > 0
        ? parseUiNumber(args.amountOutUi) / parseUiNumber(args.amountInUi)
        : 0;
  return parseUiNumber(args.amountInUi) * mid;
}

/** Execution price in quote-per-share for a bStock ↔ stable swap. */
export function executionQuotePerUnit(args: {
  tokenIn: TokenRecord;
  tokenOut: TokenRecord;
  amountInUi: string;
  amountOutUi: string;
}): number {
  const ain = parseUiNumber(args.amountInUi);
  const aout = parseUiNumber(args.amountOutUi);
  if (!(ain > 0) || !(aout > 0)) return 0;
  if (args.tokenIn.kind === "stable") return ain / aout;
  if (args.tokenOut.kind === "stable") return aout / ain;
  return 0;
}

export function priceDeviationBps(execQuotePerUnit: number, midQuotePerUnit: number): number {
  if (!(midQuotePerUnit > 0) || !(execQuotePerUnit > 0)) return 0;
  return Math.round((Math.abs(execQuotePerUnit - midQuotePerUnit) / midQuotePerUnit) * 10_000);
}

export function formatPrice(n: number, maxFrac = 4): string {
  if (!(n > 0) || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac, minimumSignificantDigits: 1 });
}

export function rangeLabel(rangeBps: number): string {
  return `±${(rangeBps / 100).toFixed(0)}%`;
}
