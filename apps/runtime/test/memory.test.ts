import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "@bstocks/termix";
import { ConversationStore, formatRuntimeState, isFundingSwapForLp, latchSwapThenLpPlan, nextConfirmKind, recoverParkedLpFromTurns, type ConversationState } from "../src/conversation.js";

const WALLET = "0x3e01a5779cfa830794dbb9c8673a61b3c5c5608a";

function msg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: "m1",
    conversationId: "termix-thread-1",
    text: "我要买100u得英伟达",
    createdAt: new Date().toISOString(),
    from: { walletAddress: WALLET, handle: "buyer" },
    ...over,
  };
}

describe("Termix conversation memory", () => {
  it("hydrates the buyer wallet from inbox.from and is idempotent on messageId", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    const first = store.ingestTermixMessage(msg());
    expect(first.duplicate).toBe(false);
    expect(first.state.wallet?.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(first.state.source).toBe("termix");
    expect(first.state.seenMessageIds).toContain("m1");

    const again = store.ingestTermixMessage(msg());
    expect(again.duplicate).toBe(true);
    expect(store.alreadySeen("termix-thread-1", "m1")).toBe(true);
  });

  it("seeds a new order thread from the sibling conversation", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.ingestTermixMessage(
      msg({ conversationId: "pre-sale", orderId: "ord-9", text: "我确认不在美国及受限地区" }),
    );
    store.ingestUserText("pre-sale", WALLET);
    const next = store.ingestTermixMessage(
      msg({
        messageId: "m2",
        conversationId: "delivery",
        orderId: "ord-9",
        text: "链接呢",
        from: { handle: "buyer" },
      }),
    );
    expect(next.state.wallet?.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(next.state.geoConfirmed).toBe(true);
  });

  it("keeps lastIntent on the memory card after a quote is cleared", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.ingestUserText("local", "我确认不在美国及受限地区");
    store.rememberIntent("local", {
      id: "intent-1",
      kind: "swap",
      signerUrl: "https://signer.example/t/intent-1",
    });
    store.clearPending("local");
    const card = formatRuntimeState(store.get("local"));
    expect(card).toContain("https://signer.example/t/intent-1");
    expect(card).toMatch(/memory card|Do not treat the user as new/);
  });

  it("clears the pending quote when the user cancels", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.ingestUserText("local", "我确认不在美国及受限地区");
    store.ingestUserText("local", WALLET);
    const s = store.get("local");
    s.lastQuote = { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "100" };
    store.save(s);
    store.rememberIntent("local", {
      id: "intent-1",
      kind: "swap",
      signerUrl: "https://signer.example/t/intent-1",
    });
    const next = store.cancelPending("local");
    expect(next.lastQuote).toBeUndefined();
    expect(next.userConfirmed).toBe(false);
    expect(next.lastIntent?.cancelled).toBe(true);
    expect(formatRuntimeState(next)).toMatch(/cancelled/i);
  });

  it("beginLocalSession drops quotes and turns but keeps wallet and geo", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.ingestUserText("local", "我确认不在美国及受限地区");
    store.ingestUserText("local", WALLET);
    const s = store.get("local");
    s.lastQuote = { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "10" };
    s.lastLpProposal = { kind: "lp-propose", token: "NVDAB", balances: { token: "1", usdt: "8", bnb: "0.1" }, options: [] };
    s.turns = [{ role: "user", content: "组LP" }];
    store.save(s);
    store.rememberIntent("local", { id: "x", kind: "lp-mint", signerUrl: "http://x" });
    const next = store.beginLocalSession("local");
    expect(next.wallet?.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(next.geoConfirmed).toBe(true);
    expect(next.lastQuote).toBeUndefined();
    expect(next.lastLpProposal).toBeUndefined();
    expect(next.turns).toBeUndefined();
    expect(next.lastIntent?.cancelled).toBe(true);
  });

  it("keeps lastSettled LP across a local session reset", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.ingestUserText("local", "我确认不在美国及受限地区");
    store.markSettled("local", {
      kind: "lp-mint",
      intentId: "lp-1",
      at: new Date().toISOString(),
      txHashes: ["0xabc"],
      pair: "NVDAB/USDT",
      tokenId: "99",
      message: "LP 已上链。仓位 NFT #99（NVDAB/USDT）。",
    });
    const next = store.beginLocalSession("local");
    expect(next.lastSettled?.tokenId).toBe("99");
    expect(formatRuntimeState(next)).toContain("NFT #99");
    expect(formatRuntimeState(next)).toContain("already settled");
  });

  it("appends transcript turns for the next LLM call", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.appendTurn("local", "user", "买100u英伟达");
    store.appendTurn("local", "assistant", "报价 100 USDT → NVDAB");
    const turns = store.get("local").turns ?? [];
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[1]?.content).toContain("NVDAB");
  });

  it("advances a swap-then-lp plan after the funding swap", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    const s = store.get("local");
    s.lastQuote = { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.007" };
    s.lastLp = { token: "NVDAB", quote: "USDT", fee: 10000, budgetQuoteUi: "10", rangeBps: 3000 };
    s.pendingPlan = {
      kind: "swap_then_lp",
      phase: "swap",
      swap: s.lastQuote,
      lp: s.lastLp,
    };
    store.save(s);
    expect(nextConfirmKind(s)).toBe("swap");
    const card = formatRuntimeState(store.get("local"));
    expect(card).toContain("current step SWAP");
    expect(card).toContain("create_swap_intent");

    const next = store.advanceSwapThenLpAfterSwap("local");
    expect(next.pendingPlan?.phase).toBe("lp");
    expect(next.lastQuote).toBeUndefined();
    expect(next.lastLp?.budgetQuoteUi).toBe("10");
    expect(nextConfirmKind(next)).toBe("lp");
    expect(formatRuntimeState(next)).toContain("current step LP mint");

    const again = store.advanceSwapThenLpAfterSwap("local");
    expect(again.pendingPlan?.phase).toBe("lp");
    expect(again.lastLp?.budgetQuoteUi).toBe("10");
  });

  it("latches a two-step plan when a BNB funding swap sits next to a parked LP", () => {
    const swap = { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.006" };
    const lp = { token: "NVDAB", quote: "USDT", fee: 10000, budgetQuoteUi: "7.4" };
    expect(isFundingSwapForLp(swap, lp)).toBe(true);
    const s: ConversationState = {
      id: "local",
      geoConfirmed: true,
      userConfirmed: false,
      lastQuote: swap,
      lastLp: lp,
      updatedAt: new Date().toISOString(),
    };
    expect(latchSwapThenLpPlan(s, swap, lp)).toBe(true);
    expect(s.pendingPlan?.kind).toBe("swap_then_lp");
    expect(nextConfirmKind(s)).toBe("swap");
    expect(formatRuntimeState(s)).toContain("current step SWAP");
  });

  it("does not treat a withdraw as a parked mint that can latch a funding swap", () => {
    const swap = { tokenIn: "BNB", tokenOut: "USDT", amountInUi: "0.006" };
    const lp = { token: "NVDAB", decreaseTokenId: "7277622", decreaseBps: 10_000 };
    expect(isFundingSwapForLp(swap, lp)).toBe(false);
    expect(nextConfirmKind({ id: "local", geoConfirmed: true, userConfirmed: false, lastQuote: swap, lastLp: lp, updatedAt: new Date().toISOString() })).toBe("none");
  });

  it("recovers a parked LP mint from the last assistant plan", () => {
    const lp = recoverParkedLpFromTurns([
      {
        role: "assistant",
        content: [
          "第一步兑换已确认上链。",
          "**组 LP 计划（NVDAB/USDT 1% 池）**",
          "- 池：NVDAB/USDT，手续费 **1%**（fee=10000）",
          "- 投入：**全部 NVDAB 0.03347131 股**（≈$7.32）+ **约 3.66 USDT**，总预算 ≈ **7.4 USDT**",
        ].join("\n"),
      },
    ]);
    expect(lp).toMatchObject({
      token: "NVDAB",
      quote: "USDT",
      fee: 10000,
      budgetQuoteUi: "7.4",
      amountTokenUi: "0.03347131",
    });
  });
});
