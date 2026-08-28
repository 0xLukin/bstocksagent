import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "@bstocks/termix";
import { ConversationStore, formatRuntimeState } from "../src/conversation.js";

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

  it("appends transcript turns for the next LLM call", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "conv-")));
    store.appendTurn("local", "user", "买100u英伟达");
    store.appendTurn("local", "assistant", "报价 100 USDT → NVDAB");
    const turns = store.get("local").turns ?? [];
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[1]?.content).toContain("NVDAB");
  });
});
