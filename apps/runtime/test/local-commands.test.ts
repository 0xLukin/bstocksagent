import { describe, expect, it } from "vitest";
import { formatRuntimeState } from "../src/conversation.js";
import { formatToolReply, parseAddLp, parseBuySell, parseLocalCommand } from "../src/localCommands.js";

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
    expect(parseLocalCommand("确定")).toEqual({ kind: "confirm" });
    expect(parseLocalCommand("我确认")).toEqual({ kind: "confirm" });
  });

  it("parses spoken 100u NVIDIA LP as a pending mint", () => {
    expect(parseAddLp("帮我加100u的英伟达lp")).toEqual({
      token: "英伟达",
      budgetQuoteUi: "100",
    });
    expect(parseLocalCommand("帮我加100u的英伟达lp")).toEqual({
      kind: "lp",
      token: "英伟达",
      budgetQuoteUi: "100",
    });
    expect(parseLocalCommand("用 100 USDT 加 NVDAB 池")).toEqual({
      kind: "lp",
      token: "NVDAB",
      budgetQuoteUi: "100",
    });
  });

  it("parses position management", () => {
    expect(parseLocalCommand("我的仓位")).toEqual({ kind: "positions" });
    expect(parseLocalCommand("收手续费")).toEqual({ kind: "collect" });
    expect(parseLocalCommand("收手续费 12345")).toEqual({ kind: "collect", tokenId: "12345" });
    expect(parseLocalCommand("全撤")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("撤一半")).toEqual({ kind: "decrease", fractionBps: 5_000 });
  });

  it("parses cancel", () => {
    expect(parseLocalCommand("取消")).toEqual({ kind: "cancel" });
    expect(parseLocalCommand("不要了")).toEqual({ kind: "cancel" });
    expect(parseLocalCommand("取消这笔兑换")).toEqual({ kind: "cancel" });
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

  it("tells the model a budget LP is pending", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: true,
      wallet: "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a",
      lastLp: { token: "NVDAB", budgetQuoteUi: "100", rangeBps: 3000 },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toContain("预算约 100 USDT");
    expect(text).toMatch(/create_lp_intent/);
  });

  it("formats a 1-share mid price", () => {
    const text = formatToolReply(
      JSON.stringify({
        display: "NVDAB ≈ 214.4 USDT / 股",
        uiPrice: "214.4",
        token: "NVDAB",
        quote: "USDT",
      }),
    );
    expect(text).toContain("NVDAB ≈ 214.4 USDT / 股");
    expect(text).toMatch(/1 股|中间价/);
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

