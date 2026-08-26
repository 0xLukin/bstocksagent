import { afterEach, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { getToken, readOnchainDecimals, resetOnchainDecimalsCache, uiDisplayToRaw } from "../src/registry.js";

afterEach(() => {
  resetOnchainDecimalsCache();
});

describe("on-chain decimals", () => {
  it("re-reads decimals() and uses that scale for parseFixed", async () => {
    const usdt = getToken("USDT");
    expect(usdt.decimals).toBe(18);
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "decimals") return 6;
        throw new Error(functionName);
      },
    } as unknown as PublicClient;

    expect(await readOnchainDecimals(client, usdt.address, 18)).toBe(6);
    const { raw } = await uiDisplayToRaw(client, usdt, "1.5");
    expect(raw).toBe(1_500_000n);
  });

  it("caches by address and falls back when the call fails", async () => {
    const usdt = getToken("USDT");
    let calls = 0;
    const client = {
      readContract: async () => {
        calls += 1;
        return 18;
      },
    } as unknown as PublicClient;
    expect(await readOnchainDecimals(client, usdt.address, 18)).toBe(18);
    expect(await readOnchainDecimals(client, usdt.address, 18)).toBe(18);
    expect(calls).toBe(1);

    resetOnchainDecimalsCache();
    const failing = {
      readContract: async () => {
        throw new Error("rpc down");
      },
    } as unknown as PublicClient;
    expect(await readOnchainDecimals(failing, usdt.address, 18)).toBe(18);
  });
});
