import { describe, expect, it } from "vitest";
import {
  getAmount0ForLiquidity,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  planLiquidityAmounts,
  Q96,
} from "../src/liquidity.js";
import { amount1FromAmount0 } from "../src/lp-math.js";
import {
  executionQuotePerUnit,
  markPairUsd,
  priceDeviationBps,
  swapNotionalUsd,
} from "../src/valuation.js";
import { getToken } from "../src/registry.js";

describe("TickMath", () => {
  it("maps tick 0 to 2^96", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });

  it("matches Uniswap min/max sqrt ratios", () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
  });
});

describe("V3 liquidity amounts", () => {
  it("uses only token0 below the range", () => {
    const sqrtA = getSqrtRatioAtTick(-100);
    const sqrtB = getSqrtRatioAtTick(100);
    const below = getSqrtRatioAtTick(-200);
    const used = getAmountsForLiquidity(below, sqrtA, sqrtB, 1_000_000n);
    expect(used.amount0).toBeGreaterThan(0n);
    expect(used.amount1).toBe(0n);
  });

  it("uses only token1 above the range", () => {
    const sqrtA = getSqrtRatioAtTick(-100);
    const sqrtB = getSqrtRatioAtTick(100);
    const above = getSqrtRatioAtTick(200);
    const used = getAmountsForLiquidity(above, sqrtA, sqrtB, 1_000_000n);
    expect(used.amount0).toBe(0n);
    expect(used.amount1).toBeGreaterThan(0n);
  });

  it("infers the other side from a single token0 amount in range", () => {
    const tickLower = -1000;
    const tickUpper = 1000;
    const planned = planLiquidityAmounts({
      sqrtPriceX96: Q96,
      tickLower,
      tickUpper,
      amount0Desired: 10n ** 18n,
      amount1Desired: 0n,
    });
    expect(planned.liquidity).toBeGreaterThan(0n);
    expect(planned.amount0).toBeGreaterThan(0n);
    expect(planned.amount1).toBeGreaterThan(0n);
    const rebuilt0 = getAmount0ForLiquidity(
      Q96,
      getSqrtRatioAtTick(tickUpper),
      planned.liquidity,
    );
    expect(rebuilt0).toBe(planned.amount0);
  });

  it("is not the spot-ratio shortcut", () => {
    const planned = planLiquidityAmounts({
      sqrtPriceX96: Q96,
      tickLower: -1000,
      tickUpper: 1000,
      amount0Desired: 10n ** 18n,
      amount1Desired: 0n,
    });
    const spot = amount1FromAmount0(10n ** 18n, Q96);
    expect(planned.amount1).not.toBe(spot);
    expect(planned.amount0).toBeLessThan(10n ** 18n + 1n);
  });
});

describe("swap notional and deviation", () => {
  it("treats a USDT spend as dollars", () => {
    const usdt = getToken("USDT");
    const nvda = getToken("NVDAB");
    expect(
      swapNotionalUsd({
        tokenIn: usdt,
        tokenOut: nvda,
        amountInUi: "100",
        amountOutUi: "0.5",
      }),
    ).toBe(100);
  });

  it("marks a bStock sell with mid × shares", () => {
    const usdt = getToken("USDT");
    const nvda = getToken("NVDAB");
    expect(
      swapNotionalUsd({
        tokenIn: nvda,
        tokenOut: usdt,
        amountInUi: "0.5",
        midQuotePerUnit: 200,
      }),
    ).toBe(100);
  });

  it("does not treat 0.5 shares as $0.5", () => {
    const usdt = getToken("USDT");
    const nvda = getToken("NVDAB");
    expect(
      swapNotionalUsd({
        tokenIn: nvda,
        tokenOut: usdt,
        amountInUi: "0.5",
        amountOutUi: "100",
      }),
    ).toBe(100);
  });

  it("measures execution vs mid in bps", () => {
    const usdt = getToken("USDT");
    const nvda = getToken("NVDAB");
    const exec = executionQuotePerUnit({
      tokenIn: usdt,
      tokenOut: nvda,
      amountInUi: "101",
      amountOutUi: "0.5",
    });
    expect(priceDeviationBps(exec, 200)).toBe(100);
  });
});

describe("markPairUsd", () => {
  it("does not treat WBNB as $1 when usdPerGas is provided", () => {
    const nvda = getToken("NVDAB");
    const wbnb = getToken("WBNB");
    const withoutGas = markPairUsd({
      token0: nvda,
      token1: wbnb,
      amount0Ui: "74.5",
      amount1Ui: "17.6",
      sqrtPriceX96: Q96,
    });
    const withGas = markPairUsd({
      token0: nvda,
      token1: wbnb,
      amount0Ui: "74.5",
      amount1Ui: "17.6",
      sqrtPriceX96: Q96,
      usdPerGas: 600,
    });
    expect(withGas).toBeCloseTo(withoutGas * 600);
    expect(withGas).toBeGreaterThan(10_000);
  });
});
