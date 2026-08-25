import { describe, expect, it } from "vitest";
import { formatRuntimeState } from "../src/conversation.js";
import { formatToolReply, parseBuySell, parseLocalCommand } from "../src/localCommands.js";

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

  it("parses spoken NVDA price queries", () => {
    expect(parseLocalCommand("查看nvda的报价")).toEqual({
      kind: "price",
      token: "nvda",
      quote: "USDT",
    });
    expect(parseLocalCommand("英伟达报价")).toEqual({
      kind: "price",
      token: "英伟达",
      quote: "USDT",
    });
  });

  it("ignores unrelated text", () => {
    expect(parseLocalCommand("你好")).toEqual({ kind: "none" });
  });

  it("parses 买100u得英伟达 as a pending USDT buy", () => {
    expect(parseBuySell("价吧，我要买100u得英伟达")).toEqual({
      tokenIn: "USDT",
      tokenOut: "英伟达",
      amountInUi: "100",
    });
    expect(parseBuySell("用 100 USDT 买 NVDAB")).toEqual({
      tokenIn: "USDT",
      tokenOut: "NVDAB",
      amountInUi: "100",
    });
    expect(parseBuySell("卖 0.5 英伟达")).toEqual({
      tokenIn: "英伟达",
      tokenOut: "USDT",
      amountInUi: "0.5",
    });
    expect(parseBuySell("查看nvda的报价")).toBeNull();
  });

  it("tells the model to execute lastQuote instead of re-asking", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: true,
      wallet: "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a",
      lastQuote: { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "100" },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toContain("100 USDT → NVDAB");
    expect(text).toMatch(/禁止再问/);
  });

  it("formats a signer URL instead of dumping JSON", () => {
    const text = formatToolReply(
      JSON.stringify({
        signerUrl: "http://127.0.0.1:3000/t/abc",
        summary: { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "100", amountOutUi: "0.46" },
      }),
    );
    expect(text).toContain("http://127.0.0.1:3000/t/abc");
    expect(text).toContain("100 USDT → 约 0.46 NVDAB");
    expect(text).not.toMatch(/^\s*\{/);
  });
});

