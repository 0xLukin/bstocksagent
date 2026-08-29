import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "@bstocks/termix";
import {
  canCreateDefiIntent,
  ConversationStore,
  formatRuntimeState,
  mergeHirePhase,
} from "../src/conversation.js";
import { isSystemHireEvent, offerMatchesListing, phaseFromOrderStatus, serviceFeeLabel } from "../src/hire.js";
import { formatToolReply, parseLocalCommand } from "../src/localCommands.js";

describe("hire phase", () => {
  it("maps Termix order status", () => {
    expect(phaseFromOrderStatus("PENDING_ACCEPT")).toBe("funded");
    expect(phaseFromOrderStatus("IN_PROGRESS")).toBe("working");
    expect(phaseFromOrderStatus("DELIVERED")).toBe("delivered");
    expect(phaseFromOrderStatus("SETTLED")).toBe("settled");
    expect(phaseFromOrderStatus("CANCELLED")).toBe("none");
  });

  it("does not downgrade phase", () => {
    expect(mergeHirePhase("working", "offered")).toBe("working");
    expect(mergeHirePhase("offered", "funded")).toBe("funded");
    expect(mergeHirePhase(undefined, "quoting")).toBe("quoting");
  });

  it("blocks DeFi intents on Termix until working", () => {
    expect(canCreateDefiIntent({ id: "c", geoConfirmed: true, userConfirmed: true, updatedAt: "", source: "local" })).toBe(
      true,
    );
    expect(
      canCreateDefiIntent({
        id: "c",
        geoConfirmed: true,
        userConfirmed: true,
        updatedAt: "",
        source: "termix",
        hirePhase: "offered",
      }),
    ).toBe(false);
    expect(
      canCreateDefiIntent({
        id: "c",
        geoConfirmed: true,
        userConfirmed: true,
        updatedAt: "",
        source: "termix",
        hirePhase: "working",
      }),
    ).toBe(true);
  });

  it("parses hire commands without stealing swap quotes", () => {
    expect(parseLocalCommand("请发标准报价")).toEqual({ kind: "hire-offer" });
    expect(parseLocalCommand("我要这个服务")).toEqual({ kind: "hire-offer" });
    expect(parseLocalCommand("send the standard offer")).toEqual({ kind: "hire-offer" });
    expect(parseLocalCommand("请交付")).toEqual({ kind: "deliver" });
    expect(parseLocalCommand("再来一单")).toEqual({ kind: "hire-offer" });
    expect(parseLocalCommand("可以开始")).toEqual({ kind: "hire-offer" });
    expect(parseLocalCommand("没做交易也交付")).toEqual({ kind: "deliver" });
    expect(parseLocalCommand("报价 USDT→NVDAB 10")).toMatchObject({ kind: "quote", tokenIn: "USDT" });
    expect(parseLocalCommand("开始")).toEqual({ kind: "none" });
  });

  it("resets a settled hire so the same Termix thread can buy again", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "hire-")));
    store.patchHire("c1", {
      hirePhase: "settled",
      lastOfferId: "old-off",
      lastOrderId: "old-ord",
      lastOrderStatus: "SETTLED",
    });
    const next = store.startNewHire("c1");
    expect(next.hirePhase).toBe("none");
    store.ingestUserText("c1", "我确认不在美国及受限地区");
    const afterGeo = store.startNewHire("c1");
    expect(afterGeo.hirePhase).toBe("quoting");
    expect(afterGeo.lastOrderId).toBeUndefined();
    expect(afterGeo.lastOfferId).toBeUndefined();
  });

  it("only treats listing-priced offers as the live hire card", () => {
    expect(offerMatchesListing({ price: "0.01", currency: "USDC" })).toBe(true);
    expect(offerMatchesListing({ price: "0.5", currency: "USDC" })).toBe(false);
  });

  it("formats delivery_needs_confirm and uses the listing fee label", () => {
    expect(serviceFeeLabel()).toMatch(/USDC|USDT/);
    const text = formatToolReply(
      JSON.stringify({
        error: "delivery_needs_confirm",
        message: "No on-chain DeFi hash is recorded yet.",
      }),
    );
    expect(text).toContain("No on-chain DeFi hash");
  });

  it("treats Termix status cards as hire events", () => {
    expect(isSystemHireEvent("订单已开通", "ord-1")).toBe(true);
    expect(isSystemHireEvent("", "ord-1")).toBe(true);
    expect(isSystemHireEvent("用 0.01 USDC 买英伟达")).toBe(false);
  });

  it("ingests Termix geo as quoting and seeds hire onto the order thread", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "hire-")));
    const first = store.ingestTermixMessage({
      messageId: "m1",
      conversationId: "pre",
      text: "我确认不在美国及受限地区",
      createdAt: new Date().toISOString(),
    } as InboxMessage);
    expect(first.state.source).toBe("termix");
    expect(first.state.hirePhase).toBe("quoting");
    store.patchHire("pre", { hirePhase: "offered", lastOfferId: "off-1", lastOrderId: "ord-1" });
    const next = store.ingestTermixMessage({
      messageId: "m2",
      conversationId: "delivery",
      orderId: "ord-1",
      text: "订单已开通",
      createdAt: new Date().toISOString(),
    } as InboxMessage);
    expect(next.state.lastOfferId).toBe("off-1");
    expect(next.state.hirePhase).toBe("offered");
    const card = formatRuntimeState({ ...store.get("pre"), source: "termix", hirePhase: "offered" });
    expect(card).toMatch(/Do NOT create a swap/i);
  });
});
