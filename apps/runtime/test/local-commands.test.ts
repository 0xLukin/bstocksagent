import { describe, expect, it } from "vitest";
import { formatRuntimeState, nextConfirmKind } from "../src/conversation.js";
import {
  bypassLlm,
  formatToolReply,
  parseAddLp,
  parseBuySell,
  parseCompareLp,
  parseLocalCommand,
  parseSpokenFee,
  rememberLp,
  wantsLpAfterTrade,
} from "../src/localCommands.js";
import type { ToolCtx } from "../src/tools.js";

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
    expect(parseLocalCommand("确认")).toEqual({ kind: "confirm" });
    expect(parseLocalCommand("确定")).toEqual({ kind: "confirm" });
    expect(parseLocalCommand("我确认")).toEqual({ kind: "confirm" });
    expect(parseLocalCommand("confirm")).toEqual({ kind: "confirm" });
    expect(parseLocalCommand("继续")).toEqual({ kind: "proceed" });
    expect(parseLocalCommand("签完了")).toEqual({ kind: "proceed" });
    expect(parseLocalCommand("next step")).toEqual({ kind: "proceed" });
    expect(parseLocalCommand("已完成 继续")).toEqual({ kind: "proceed" });
    expect(parseLocalCommand("已完成")).toEqual({ kind: "proceed" });
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
    expect(parseAddLp("加 100u 那个最高的")).toEqual({
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
    expect(parseAddLp("加 100u 英伟达 WBNB 0.25%")).toMatchObject({
      token: "英伟达",
      budgetQuoteUi: "100",
      quote: "WBNB",
      fee: 2500,
    });
    expect(parseAddLp("加那个最高的100u")).toEqual({
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
    expect(parseLocalCommand("加 100u 那个最高的")).toEqual({
      kind: "lp",
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
    expect(parseLocalCommand("帮我加100u的英伟达lp").kind).toBe("lp");
    expect(parseLocalCommand("帮我加100u的英伟达lp")).not.toMatchObject({ pick: "highest" });
    expect(parseAddLp("add 100u nvidia lp")).toEqual({
      token: "nvidia",
      budgetQuoteUi: "100",
    });
    expect(parseAddLp("add 100u to the best pool")).toMatchObject({
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
    expect(parseAddLp("那帮我加100刀到最好的那个池子吧")).toEqual({
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
    expect(parseLocalCommand("那帮我加100刀到最好的那个池子吧")).toEqual({
      kind: "lp",
      token: "",
      budgetQuoteUi: "100",
      pick: "highest",
    });
  });

  it("parses 组LP as an open-ended propose, not confirm", () => {
    expect(parseAddLp("组LP")).toEqual({ token: "" });
    expect(parseLocalCommand("组 LP")).toEqual({ kind: "lp", token: "" });
    expect(parseAddLp("帮我组个英伟达lp")).toMatchObject({ token: "英伟达" });
    expect(parseAddLp("我想组nvdab的lp 帮我规划最优方案")).toMatchObject({ token: "nvdab" });
    expect(parseLocalCommand("我想组nvdab的lp 帮我规划最优方案")).toMatchObject({
      kind: "lp",
      token: "nvdab",
    });
    expect(parseLocalCommand("确认")).toEqual({ kind: "confirm" });
  });

  it("parses LP APR questions as compare, not price", () => {
    expect(parseCompareLp("英伟达目前最高apr收益的lp是哪个")).toEqual({ token: "英伟达" });
    expect(parseLocalCommand("英伟达最高apr能到多少")).toEqual({ kind: "lp-compare", token: "英伟达" });
    expect(parseLocalCommand("spcx 池子怎么样")).toEqual({ kind: "lp-compare", token: "spcx" });
    expect(parseCompareLp("查看nvda的报价")).toBeNull();
    expect(parseCompareLp("nvidia highest apr")).toEqual({ token: "nvidia" });
    expect(parseSpokenFee("WBNB 0.25%")).toBe(2500);
  });

  it("parses position management", () => {
    expect(parseLocalCommand("my positions")).toEqual({ kind: "positions" });
    expect(parseLocalCommand("我的仓位")).toEqual({ kind: "positions" });
    expect(parseLocalCommand("看看仓位")).toEqual({ kind: "positions" });
    expect(parseLocalCommand("看看我的仓位")).toEqual({ kind: "positions" });
    expect(parseLocalCommand("收手续费")).toEqual({ kind: "collect" });
    expect(parseLocalCommand("帮我领取手续费")).toEqual({ kind: "collect" });
    expect(parseLocalCommand("收手续费 12345")).toEqual({ kind: "collect", tokenId: "12345" });
    expect(parseLocalCommand("全撤")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("撤一半")).toEqual({ kind: "decrease", fractionBps: 5_000 });
    expect(parseLocalCommand("赎回")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("退出全部仓位")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("帮我把 NVDAB 的lp 仓位赎回")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("帮我把nvdab的lp仓位赎回")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("组 LP").kind).toBe("lp");
    expect(parseLocalCommand("能买什么")).toEqual({ kind: "catalog" });
    expect(parseLocalCommand("加仓 10 USDT")).toEqual({ kind: "increase", amountQuoteUi: "10" });
    expect(parseLocalCommand("改成一半")).toEqual({ kind: "amend-half" });
    expect(parseLocalCommand("换成 BNB")).toEqual({ kind: "amend-pay", tokenIn: "BNB" });
    expect(parseLocalCommand("再报一次")).toEqual({ kind: "requote" });
    expect(parseLocalCommand("把赎回的卖掉")).toEqual({ kind: "sell-dust" });
    expect(parseLocalCommand("用 20 USDT 买英伟达然后组LP")).toMatchObject({
      kind: "quote",
      tokenIn: "USDT",
      tokenOut: "英伟达",
      amountInUi: "20",
    });
    expect(wantsLpAfterTrade("用 20 USDT 买英伟达然后组LP")).toBe(true);
    expect(wantsLpAfterTrade("用 20 USDT 买英伟达")).toBe(false);
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
    expect(parseLocalCommand("查询一下nvdab的报价")).toEqual({
      kind: "price",
      token: "nvdab",
      quote: "USDT",
    });
    expect(parseLocalCommand("需要新的报价")).toEqual({ kind: "none" });
    expect(parseLocalCommand("需要新的报价 我要用0.01 bnb 买 nvdab")).toEqual({
      kind: "quote",
      tokenIn: "BNB",
      tokenOut: "nvdab",
      amountInUi: "0.01",
    });
  });

  it("keeps buy/sell/price on the rule path even when an LLM key is present", () => {
    expect(bypassLlm("quote", true)).toBe(true);
    expect(bypassLlm("price", true)).toBe(true);
    expect(bypassLlm("lp", true)).toBe(false);
    expect(bypassLlm("lp-compare", true)).toBe(false);
    expect(bypassLlm("confirm", true)).toBe(true);
    expect(bypassLlm("proceed", true)).toBe(true);
    expect(bypassLlm("cancel", true)).toBe(true);
    expect(bypassLlm("decrease", true)).toBe(true);
    expect(bypassLlm("collect", true)).toBe(true);
    expect(bypassLlm("positions", true)).toBe(true);
    expect(bypassLlm("quote", false)).toBe(true);
    expect(bypassLlm("catalog", true)).toBe(true);
    expect(bypassLlm("increase", true)).toBe(true);
    expect(bypassLlm("amend-half", true)).toBe(true);
    expect(bypassLlm("none", true)).toBe(false);
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
    expect(parseBuySell("用 0.05 BNB 买英伟达")).toEqual({
      tokenIn: "BNB",
      tokenOut: "英伟达",
      amountInUi: "0.05",
    });
    expect(parseBuySell("卖 0.5 英伟达换 BNB")).toEqual({
      tokenIn: "英伟达",
      tokenOut: "BNB",
      amountInUi: "0.5",
    });
    expect(parseBuySell("用 0.05 WBNB 买 NVDAB")).toEqual({
      tokenIn: "WBNB",
      tokenOut: "NVDAB",
      amountInUi: "0.05",
    });
    expect(parseBuySell("buy 100 USDT of NVDAB")).toEqual({
      tokenIn: "USDT",
      tokenOut: "NVDAB",
      amountInUi: "100",
    });
    expect(parseBuySell("用 0.01 USDC 买英伟达")).toEqual({
      tokenIn: "USDC",
      tokenOut: "英伟达",
      amountInUi: "0.01",
    });
    expect(parseBuySell("buy 0.01 USDC of NVDAB")).toEqual({
      tokenIn: "USDC",
      tokenOut: "NVDAB",
      amountInUi: "0.01",
    });
    expect(parseBuySell("买 0.01 USDC 的英伟达")).toEqual({
      tokenIn: "USDC",
      tokenOut: "英伟达",
      amountInUi: "0.01",
    });
    expect(parseBuySell("sell 0.5 NVIDIA")).toEqual({
      tokenIn: "NVIDIA",
      tokenOut: "USDT",
      amountInUi: "0.5",
    });
    expect(parseBuySell("全部USDT买英伟达")).toEqual({
      tokenIn: "USDT",
      tokenOut: "英伟达",
      amountInUi: "all",
    });
    expect(parseLocalCommand("全部 USDT 买英伟达")).toEqual({
      kind: "quote",
      tokenIn: "USDT",
      tokenOut: "英伟达",
      amountInUi: "all",
    });
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
    expect(text).toMatch(/Do not re-ask/);
    expect(text).toMatch(/not a Termix hire/);
  });

  it("clears a leftover two-step plan when remembering a withdraw", () => {
    const conversation: {
      id: string;
      lastQuote?: { tokenIn: string; tokenOut: string; amountInUi: string };
      pendingPlan?: unknown;
      lastLpProposal?: unknown;
      lastLp?: { token: string; decreaseTokenId?: string; decreaseBps?: number };
    } = {
      id: "local",
      lastQuote: { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.01" },
      pendingPlan: {
        kind: "swap_then_lp" as const,
        phase: "swap" as const,
        swap: { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.01" },
        lp: { token: "NVDAB", quote: "USDT", fee: 10000, budgetQuoteUi: "8" },
      },
      lastLpProposal: {
        kind: "lp-propose" as const,
        token: "NVDAB",
        balances: { token: "1", usdt: "0", bnb: "0.1" },
        options: [{ n: 1, action: "fund" as const, title: "x", token: "NVDAB", quote: "USDT", fee: 10000, feeLabel: "1%", apr24hPct: 0, needTokenUi: "1", needQuoteUi: "8", note: "" }],
      },
    };
    rememberLp(
      {
        conversation,
        conversations: { save: () => undefined },
      } as unknown as ToolCtx,
      { token: "NVDAB", decreaseTokenId: "7277622", decreaseBps: 10_000 },
    );
    expect(conversation.pendingPlan).toBeUndefined();
    expect(conversation.lastQuote).toBeUndefined();
    expect(conversation.lastLpProposal).toBeUndefined();
    expect(conversation.lastLp).toMatchObject({ decreaseTokenId: "7277622", decreaseBps: 10_000 });
    expect(nextConfirmKind(conversation as never)).toBe("none");
  });

  it("tells the model a pending withdraw must execute on confirm, not replay lastSettled", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: false,
      wallet: "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a",
      lastLp: { token: "NVDAB", decreaseTokenId: "7277622", decreaseBps: 10_000 },
      lastSettled: {
        kind: "lp-mint",
        intentId: "lp-1",
        at: new Date().toISOString(),
        txHashes: ["0xabc"],
        pair: "NVDAB/USDT",
        tokenId: "7277622",
        message: "LP 已上链。仓位 NFT #7277622（NVDAB/USDT）。",
      },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toContain("Pending withdraw: NFT #7277622");
    expect(text).toMatch(/bare 确认 is NOT this settlement/i);
    expect(text).toMatch(/赎回/);
  });

  it("tells the model a named APR pool is pending and must not revert to USDT 2500", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: true,
      wallet: "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a",
      lastLp: { token: "NVDAB", quote: "WBNB", fee: 2500, budgetQuoteUi: "100", rangeBps: 3000 },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toContain("WBNB");
    expect(text).toContain("fee 2500");
    expect(text).toMatch(/do not revert to the default USDT 2500/i);
  });

  it("tells the model a prior APR compare can be used to mint a named pool", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: false,
      lastLpCompare: {
        kind: "lp-compare",
        token: "NVDAB",
        pools: [],
        ranked: [],
        highestApr: {
          token: "NVDAB",
          quote: "WBNB",
          fee: 2500,
          feeLabel: "0.25%",
          pool: "0x1111111111111111111111111111111111111111",
          tvlUsd: 28000,
          volumeUsd24h: 90000,
          apr24hPct: 210,
          thin: false,
        },
        disclaimer: "",
      },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toContain("Already compared NVDAB");
    expect(text).toMatch(/WBNB 0\.25%/);
    expect(text).toMatch(/create_lp_intent/);
  });

  it("formats compared LP pools without promising yield", () => {
    const text = formatToolReply(
      JSON.stringify({
        kind: "lp-compare",
        token: "NVDAB",
        disclaimer: "Not a yield promise.",
        highestApr: { quote: "WBNB", feeLabel: "0.25%", apr24hPct: 210, tvlUsd: 28000 },
        thickest: { quote: "USDT", feeLabel: "0.25%", tvlUsd: 1_600_000 },
        pools: [
          { quote: "USDT", feeLabel: "0.25%", apr24hPct: 190, tvlUsd: 1_600_000, volumeUsd24h: 500000, thin: false },
          { quote: "WBNB", feeLabel: "0.25%", apr24hPct: 210, tvlUsd: 28000, volumeUsd24h: 90000, thin: false },
        ],
      }),
    );
    expect(text).toContain("Highest non-thin: WBNB 0.25%");
    expect(text).toContain("190.0%");
    expect(text).toContain("Not a yield promise");
    expect(text).not.toMatch(/guarantee|guaranteed|稳赚/);
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
    expect(text).toContain("budget ~ 100");
    expect(text).toMatch(/create_lp_intent/);
  });

  it("formats a 1-share mid price", () => {
    const text = formatToolReply(
      JSON.stringify({
        display: "NVDAB ≈ 214.4 USDT / share",
        uiPrice: "214.4",
        token: "NVDAB",
        quote: "USDT",
      }),
    );
    expect(text).toContain("NVDAB ≈ 214.4 USDT / share");
    expect(text).toMatch(/1 share|pool mid/i);
  });

  it("formats hire_not_ready instead of dumping JSON", () => {
    const text = formatToolReply(
      JSON.stringify({
        error: "hire_not_ready",
        hirePhase: "offered",
        message: "Termix hire is not in working yet.",
      }),
    );
    expect(text).toContain("not in working");
    expect(text).not.toMatch(/^\s*\{/);
  });

  it("formats a standard offer receipt", () => {
    const text = formatToolReply(JSON.stringify({ ok: true, offerId: "off-1" }));
    expect(text).toContain("Standard offer sent");
    expect(text).toContain("off-1");
  });

  it("formats a signer URL instead of dumping JSON", () => {
    const text = formatToolReply(
      JSON.stringify({
        signerUrl: "http://127.0.0.1:3000/t/abc",
        summary: { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "100", amountOutUi: "0.46" },
      }),
    );
    expect(text).toContain("http://127.0.0.1:3000/t/abc");
    expect(text).toContain("100 USDT → ~0.46 NVDAB");
    expect(text).not.toMatch(/^\s*\{/);
    const zh = formatToolReply(
      JSON.stringify({
        signerUrl: "http://127.0.0.1:3000/t/abc",
        summary: { tokenIn: "BNB", tokenOut: "NVDAB", amountInUi: "0.01", amountOutUi: "0.03" },
      }),
      { zh: true },
    );
    expect(zh).toContain("签名页已生成");
    expect(zh).toContain("签名链接：");
  });

  it("formats a swap quote as spoken Chinese, not JSON", () => {
    const text = formatToolReply(
      JSON.stringify({
        tokenIn: { symbol: "WBNB", name: "Wrapped BNB", kind: "gas" },
        tokenOut: { symbol: "NVDAB", name: "NVIDIA (bStocks)", kind: "bstock" },
        amountInUi: "0.01",
        amountOutUi: "0.03138068",
        fee: 2500,
        nativeIn: true,
        nativeOut: false,
        hops: [{ tokenIn: "WBNB", tokenOut: "NVDAB", fee: 2500 }],
        reminder: "raw dump should not appear",
        amountInRaw: "10000000000000000",
      }),
      { zh: true },
    );
    expect(text).toContain("买入 NVDAB（英伟达）");
    expect(text).toContain("0.01 BNB");
    expect(text).toContain("原生 BNB");
    expect(text).toContain("0.25%");
    expect(text).toContain("确认");
    expect(text).not.toContain("amountInRaw");
    expect(text).not.toMatch(/^\s*\{/);
  });

  it("formats a swap-then-lp plan in Chinese", () => {
    const text = formatToolReply(
      JSON.stringify({
        kind: "swap_then_lp",
        phase: "swap",
        swap: { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.007" },
        amountOutUi: "4.8",
        lp: { token: "NVDAB", quote: "USDT", fee: 10000, budgetQuoteUi: "10" },
      }),
      { zh: true },
    );
    expect(text).toContain("分两步");
    expect(text).toContain("0.007 BNB");
    expect(text).toContain("NVDAB/USDT");
    expect(text).toContain("不用去交易所补");
  });

  it("formats numbered LP options", () => {
    const text = formatToolReply(
      JSON.stringify({
        kind: "lp-propose",
        token: "NVDAB",
        balances: { token: "0.03", usdt: "0", bnb: "0.11" },
        options: [
          {
            n: 1,
            action: "mint",
            title: "NVDAB/USDT 1% · 用现有余额",
            note: "现在就能组：约 0.01 NVDAB + 2 USDT。",
          },
          {
            n: 2,
            action: "fund",
            title: "NVDAB/USDT 1% · 先用 BNB 补 USDT",
            note: "USDT 还差约 5。用 0.007 BNB 换成约 5 USDT，再组 LP。",
          },
        ],
      }),
      { zh: true },
    );
    expect(text).toContain("回复数字选方案");
    expect(text).toContain("1. NVDAB/USDT 1% · 用现有余额");
    expect(text).toContain("先用 BNB 补 USDT");
    expect(text).not.toContain("http://");
  });

  it("mentions step 2 when the swap signer parks an LP", () => {
    const text = formatToolReply(
      JSON.stringify({
        signerUrl: "http://127.0.0.1:3000/t/abc",
        summary: {
          tokenIn: "BNB",
          tokenOut: "USDT",
          amountInUi: "0.01168",
          amountOutUi: "8.01",
          parkedLp: { token: "NVDAB", quote: "USDT", fee: 10000, budgetQuoteUi: "8" },
        },
      }),
      { zh: true },
    );
    expect(text).toContain("0.01168 BNB");
    expect(text).toContain("签完了");
    expect(text).toContain("两步");
  });

  it("formats a settled LP without a signer page", () => {
    const text = formatToolReply(
      JSON.stringify({
        kind: "lp-settled",
        message: "LP 已上链。仓位 NFT #99（NVDAB/USDT）。不是投资建议。可以说「我的仓位」查看。",
        tokenId: "99",
        pair: "NVDAB/USDT",
      }),
      { zh: true },
    );
    expect(text).toContain("NFT #99");
    expect(text).not.toContain("{");
  });

  it("labels a withdraw signer page as 退出仓位, not a new mint", () => {
    const text = formatToolReply(
      JSON.stringify({
        signerUrl: "http://127.0.0.1:3000/t/dec",
        summary: {
          tokenId: "7277622",
          token0: "NVDAB",
          token1: "USDT",
          amount0Ui: "0.018",
          amount1Ui: "4.05",
          decreaseBps: 10000,
          burn: true,
        },
      }),
      { zh: true },
    );
    expect(text).toContain("退出仓位");
    expect(text).toContain("http://127.0.0.1:3000/t/dec");
    expect(text).toContain("#7277622");
  });
});

describe("parseLpOptionNumber", () => {
  it("parses 1/2/方案一", async () => {
    const { parseLpPick, lpPickWantsExecute } = await import("../src/lpPropose.js");
    expect(parseLpPick("1")).toBe(1);
    expect(parseLpPick("方案2")).toBe(2);
    expect(parseLpPick("第一个")).toBe(1);
    expect(parseLpPick("确认方案1")).toBe(1);
    expect(parseLpPick("确认 2")).toBe(2);
    expect(parseLpPick("确认")).toBeNull();
    expect(lpPickWantsExecute("1")).toBe(false);
    expect(lpPickWantsExecute("方案1")).toBe(false);
    expect(lpPickWantsExecute("确认方案1")).toBe(true);
  });
});

