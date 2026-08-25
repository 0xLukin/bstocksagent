import { describe, expect, it } from "vitest";
import { parseLocalCommand } from "../src/localCommands.js";

describe("parseLocalCommand", () => {
  it("parses a swap quote", () => {
    expect(parseLocalCommand("报价 USDT→NVDAB 10")).toEqual({
      kind: "quote",
      tokenIn: "USDT",
      tokenOut: "NVDAB",
      amountInUi: "10",
    });
  });

  it("parses confirm", () => {
    expect(parseLocalCommand("确认执行")).toEqual({ kind: "confirm" });
  });

  it("parses LP analyze and mint", () => {
    expect(parseLocalCommand("分析 NVDAB")).toEqual({ kind: "lp", token: "NVDAB" });
    expect(parseLocalCommand("加LP NVDAB 0.01")).toEqual({
      kind: "lp",
      token: "NVDAB",
      amountTokenUi: "0.01",
    });
  });

  it("ignores unrelated text", () => {
    expect(parseLocalCommand("你好")).toEqual({ kind: "none" });
  });
});
