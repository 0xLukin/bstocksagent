/** Uniswap V3 / Pancake V3 tick helpers used for LP range selection. */

import { MAX_TICK, MIN_TICK } from "./liquidity.js";

export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (tickSpacing <= 0) throw new Error("tickSpacing must be > 0");
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  if (rounded > MAX_TICK) return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return rounded;
}

/** Approximate tick from a human price of token1 per token0 (same decimals assumed). */
export function tickFromPrice(price: number): number {
  if (!(price > 0)) throw new Error("price must be > 0");
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function priceFromTick(tick: number): number {
  return 1.0001 ** tick;
}

/**
 * Build a symmetric % band around the current tick.
 * rangeBps=3000 → ±30% in price space.
 */
export function rangeAroundTick(
  currentTick: number,
  tickSpacing: number,
  rangeBps: number,
): { tickLower: number; tickUpper: number } {
  const factor = 1 + rangeBps / 10_000;
  const delta = Math.abs(tickFromPrice(factor));
  const lower = nearestUsableTick(currentTick - delta, tickSpacing);
  const upper = nearestUsableTick(currentTick + delta, tickSpacing);
  if (upper <= lower) {
    return {
      tickLower: nearestUsableTick(currentTick - tickSpacing, tickSpacing),
      tickUpper: nearestUsableTick(currentTick + tickSpacing, tickSpacing),
    };
  }
  return { tickLower: lower, tickUpper: upper };
}

export function encodeV3Path(parts: Array<{ token: `0x${string}`; fee?: number }>): `0x${string}` {
  let hex = "0x";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    hex += p.token.slice(2).toLowerCase();
    if (i < parts.length - 1) {
      if (p.fee === undefined) throw new Error("fee required between path hops");
      hex += p.fee.toString(16).padStart(6, "0");
    }
  }
  return hex as `0x${string}`;
}

export function applySlippage(amount: bigint, slippageBps: number, side: "minOut" | "maxIn"): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) throw new Error("slippageBps out of range");
  if (side === "minOut") {
    return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
  }
  return (amount * BigInt(10_000 + slippageBps)) / 10_000n;
}
