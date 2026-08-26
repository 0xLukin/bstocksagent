import { describe, expect, it } from "vitest";
import { getToken } from "../src/registry.js";
import {
  feeTierLabel,
  pickComparedPool,
  rankWhitelistV3Pools,
  type ComparedLpPool,
} from "../src/lp-compare.js";
import type { ExplorerPoolRow } from "../src/explorer.js";

const nvda = getToken("NVDAB").address;
const usdt = getToken("USDT").address;
const wbnb = getToken("WBNB").address;

function row(over: Partial<ExplorerPoolRow> & { id: string; feeTier: number }): ExplorerPoolRow {
  return {
    chainId: 56,
    protocol: "v3",
    tvlUSD: 1_000_000,
    volumeUSD24h: 500_000,
    apr24h: 0.5,
    token0: { id: nvda, symbol: "NVDAB" },
    token1: { id: usdt, symbol: "USDT" },
    ...over,
  };
}

describe("rankWhitelistV3Pools", () => {
  it("keeps whitelist V3 quote pairs and marks thin pools", () => {
    const ranked = rankWhitelistV3Pools("英伟达", [
      row({ id: "0x1111111111111111111111111111111111111111", feeTier: 2500, apr24h: 1.9, tvlUSD: 1_600_000 }),
      row({
        id: "0x2222222222222222222222222222222222222222",
        feeTier: 2500,
        apr24h: 2.1,
        tvlUSD: 28_000,
        volumeUSD24h: 90_000,
        token1: { id: wbnb, symbol: "WBNB" },
      }),
      row({
        id: "0x3333333333333333333333333333333333333333",
        feeTier: 100,
        apr24h: 9,
        tvlUSD: 7,
        volumeUSD24h: 0,
      }),
      row({
        id: "0x4444444444444444444444444444444444444444",
        feeTier: 2500,
        protocol: "v2",
        apr24h: 0.7,
      }),
    ]);
    expect(ranked.pools.map((p) => p.quote + p.feeLabel)).toEqual(["USDT0.25%", "WBNB0.25%", "USDT0.01%"]);
    expect(ranked.pools.find((p) => p.fee === 100)?.thin).toBe(true);
    expect(ranked.highestApr?.quote).toBe("WBNB");
    expect(ranked.highestApr?.apr24hPct).toBeCloseTo(210);
    expect(ranked.thickest?.quote).toBe("USDT");
  });

  it("picks an explicit quote+fee even when ranking would choose another", () => {
    const result = rankWhitelistV3Pools("NVDAB", [
      row({ id: "0x1111111111111111111111111111111111111111", feeTier: 2500, apr24h: 0.5 }),
      row({
        id: "0x2222222222222222222222222222222222222222",
        feeTier: 2500,
        apr24h: 2.1,
        token1: { id: wbnb, symbol: "WBNB" },
      }),
    ]);
    const picked = pickComparedPool(result, { quote: "USDT", fee: 2500 }) as ComparedLpPool;
    expect(picked.quote).toBe("USDT");
    expect(pickComparedPool(result, { pick: "highest" })?.quote).toBe("WBNB");
  });
});

describe("feeTierLabel", () => {
  it("formats pancake fee tiers", () => {
    expect(feeTierLabel(2500)).toBe("0.25%");
    expect(feeTierLabel(500)).toBe("0.05%");
    expect(feeTierLabel(10000)).toBe("1%");
    expect(feeTierLabel(100)).toBe("0.01%");
  });
});
