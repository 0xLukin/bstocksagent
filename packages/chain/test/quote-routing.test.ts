import { describe, expect, it } from "vitest";
import { PANCAKE_BSC } from "../src/addresses.js";
import {
  hopFeeTiers,
  pickBestQuote,
  quoteBridges,
  quoteFeeTiers,
  richerQuote,
} from "../src/quote.js";
import { getToken, pancakeFromConfig, swapAssetSymbol, wantsNativeBnb } from "../src/registry.js";
import { pathFromHops, planSwapPayments } from "../src/swap.js";
import { encodeV3Path } from "../src/ticks.js";

describe("quote routing config", () => {
  it("uses preferredFee then feeTiers, or a single explicit fee", () => {
    expect(quoteFeeTiers()).toEqual([2500, 100, 500, 10000]);
    expect(quoteFeeTiers(500)).toEqual([500]);
  });

  it("walks quotePriority and skips the pair itself", () => {
    const usdt = getToken("USDT");
    const nvda = getToken("NVDAB");
    expect(quoteBridges(usdt, nvda).map((t) => t.symbol)).toEqual(["USDC", "WBNB"]);
    expect(quoteBridges(getToken("WBNB"), nvda).map((t) => t.symbol)).toEqual(["USDT", "USDC"]);
  });

  it("prefers a configured pool fee first on a hop", () => {
    expect(hopFeeTiers(getToken("NVDAB"), getToken("USDT"))[0]).toBe(2500);
  });

  it("picks the richer quote, then fewer hops on a tie", () => {
    const single = {
      amountOut: 10n,
      fee: 2500,
      route: "v3-single" as const,
      hops: [{ tokenIn: "USDT", tokenOut: "NVDAB", fee: 2500 }],
    };
    const two = {
      amountOut: 10n,
      fee: 2500,
      route: "smart-router" as const,
      hops: [
        { tokenIn: "USDT", tokenOut: "WBNB", fee: 2500 },
        { tokenIn: "WBNB", tokenOut: "NVDAB", fee: 2500 },
      ],
    };
    expect(richerQuote(two, single)).toBe(single);
    expect(richerQuote(single, { ...two, amountOut: 11n }).amountOut).toBe(11n);
  });

  it("does not pick a thin fee tier just because amountOut is a hair higher", () => {
    const thin = {
      amountOut: 4690n,
      fee: 500,
      tvlUsd: 738,
      route: "v3-single" as const,
      hops: [{ tokenIn: "USDT", tokenOut: "NVDAB", fee: 500 }],
    };
    const thick = {
      amountOut: 4680n,
      fee: 2500,
      tvlUsd: 1_600_000,
      route: "v3-single" as const,
      hops: [{ tokenIn: "USDT", tokenOut: "NVDAB", fee: 2500 }],
    };
    expect(pickBestQuote([thin, thick], 5000)?.fee).toBe(2500);
    expect(pickBestQuote([thin], 5000)?.fee).toBe(500);
    expect(pickBestQuote([thin, { ...thick, tvlUsd: undefined }], 5000)?.fee).toBe(2500);
  });
});

describe("native BNB vs WBNB", () => {
  it("keeps spoken BNB distinct from WBNB", () => {
    expect(wantsNativeBnb("BNB")).toBe(true);
    expect(wantsNativeBnb("bnb")).toBe(true);
    expect(wantsNativeBnb("WBNB")).toBe(false);
    expect(wantsNativeBnb(getToken("WBNB").address)).toBe(false);
    expect(swapAssetSymbol("BNB")).toBe("BNB");
    expect(swapAssetSymbol("wbnb")).toBe("WBNB");
    expect(getToken("BNB").symbol).toBe("WBNB");
  });

  it("plans native payment without an ERC-20 approve", () => {
    const quote = {
      nativeIn: true,
      nativeOut: false,
      amountInRaw: 10n ** 17n,
    };
    expect(planSwapPayments(quote as never, 0n)).toEqual({
      needsApprove: false,
      value: 10n ** 17n,
    });
    expect(planSwapPayments({ ...quote, nativeIn: false } as never, 0n).needsApprove).toBe(true);
  });
});

describe("multi-hop path", () => {
  it("encodes the actual mid token, not a hardcoded WBNB", () => {
    const hops = [
      { tokenIn: "USDT", tokenOut: "USDC", fee: 100 },
      { tokenIn: "USDC", tokenOut: "NVDAB", fee: 2500 },
    ];
    expect(pathFromHops(hops)).toBe(
      encodeV3Path([
        { token: getToken("USDT").address, fee: 100 },
        { token: getToken("USDC").address, fee: 2500 },
        { token: getToken("NVDAB").address },
      ]),
    );
  });
});

describe("Permit2 config", () => {
  it("checksums the configured Permit2 against the canonical address", () => {
    expect(pancakeFromConfig().permit2).toBe(PANCAKE_BSC.permit2);
  });
});
