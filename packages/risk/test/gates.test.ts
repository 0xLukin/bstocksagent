import { describe, expect, it } from "vitest";
import { evaluateRisk, latchGeoConfirm, latchUserConfirm } from "../src/gates.js";
import type { RiskConfig, RiskContext } from "../src/types.js";

const cfg: RiskConfig = {
  maxSlippageBps: 80,
  defaultSlippageBps: 50,
  maxNotionalUsd: 2000,
  minPoolLiquidityUsd: 5000,
  maxPriceDeviationBps: 150,
  deadlineSeconds: 180,
  restrictedGeos: ["US"],
  requireGeoConfirm: true,
  requireUserConfirmBeforeIntent: true,
  rejectZeroAmountMin: true,
  boundedApproveOnly: true,
};

function base(over: Partial<RiskContext> = {}): RiskContext {
  return {
    tokenIn: "USDT",
    tokenOut: "NVDAB",
    whitelistOk: true,
    slippageBps: 50,
    notionalUsd: 100,
    poolLiquidityUsd: 20_000,
    priceDeviationBps: 10,
    amountMin: 1n,
    geoConfirmed: true,
    userConfirmed: true,
    ...over,
  };
}

describe("risk gates", () => {
  it("passes a healthy whitelist swap", () => {
    expect(evaluateRisk(base(), cfg).ok).toBe(true);
  });

  it("blocks missing geo + confirm + zero amountMin + off-whitelist", () => {
    const v = evaluateRisk(
      base({
        geoConfirmed: false,
        userConfirmed: false,
        whitelistOk: false,
        amountMin: 0n,
      }),
      cfg,
    );
    expect(v.ok).toBe(false);
    expect(v.blockers.length).toBeGreaterThanOrEqual(4);
  });

  it("blocks US geo even if latched", () => {
    const v = evaluateRisk(base({ geo: "US", geoConfirmed: true }), cfg);
    expect(v.ok).toBe(false);
  });

  it("blocks oversized slippage and notional", () => {
    const v = evaluateRisk(base({ slippageBps: 200, notionalUsd: 5000 }), cfg);
    expect(v.ok).toBe(false);
  });
});

describe("confirmation latches", () => {
  it("latches a Chinese non-US declaration", () => {
    expect(latchGeoConfirm(false, "我确认不在美国及受限地区")).toBe(true);
  });

  it("does not latch a US residence claim", () => {
    expect(latchGeoConfirm(false, "我是美国居住")).toBe(false);
  });

  it("latches explicit user confirm", () => {
    expect(latchUserConfirm(false, "确认执行")).toBe(true);
    expect(latchUserConfirm(false, "看看报价")).toBe(false);
  });
});
