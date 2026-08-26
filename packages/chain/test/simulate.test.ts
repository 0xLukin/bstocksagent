import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { fallbackGasLimit, isAllowanceSimError, simulatePreparedTxs } from "../src/simulate.js";

const from = "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a" as Address;
const to = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4" as Address;

describe("simulatePreparedTxs", () => {
  it("treats allowance revert after a prior approve as a soft estimate", async () => {
    let calls = 0;
    const client = {
      call: async () => {
        calls += 1;
        if (calls === 1) return { data: "0x" };
        throw new Error("ERC20: transfer amount exceeds allowance");
      },
      estimateGas: async () => 80_000n,
      getGasPrice: async () => 1n,
    } as unknown as PublicClient;

    const result = await simulatePreparedTxs(client, from, [
      { to, data: "0x12", value: 0n, label: "approve 1 raw to router" },
      { to, data: "0x34", value: 0n, label: "swap USDT→NVDAB via v3-single" },
    ]);
    expect(result.hardFail).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.gasLimit).toBe(80_000n + fallbackGasLimit("swap USDT→NVDAB via v3-single"));
  });

  it("hard-fails a non-allowance revert", async () => {
    const client = {
      call: async () => {
        throw new Error("Too little received");
      },
      estimateGas: async () => 1n,
      getGasPrice: async () => 1n,
    } as unknown as PublicClient;
    expect(isAllowanceSimError("Too little received")).toBe(false);
    const result = await simulatePreparedTxs(client, from, [
      { to, data: "0x99", value: 0n, label: "swap USDT→NVDAB via v3-single" },
    ]);
    expect(result.hardFail).toBe(true);
    expect(result.ok).toBe(false);
  });
});
