import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import type { CompareLpResult } from "@bstocks/chain";
import { latchGeoConfirm, latchUserConfirm } from "@bstocks/risk";
import { listingDraft, type InboxMessage } from "@bstocks/termix";

export type PendingQuote = { tokenIn: string; tokenOut: string; amountInUi: string };
export type PendingLp = {
  token: string;
  quote?: string;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  rangeBps?: number;
  fee?: number;
  collectTokenId?: string;
  increaseTokenId?: string;
  decreaseTokenId?: string;
  decreaseBps?: number;
};

export type ChatTurn = { role: "user" | "assistant"; content: string; at?: string; messageId?: string };
export type LastIntent = {
  id: string;
  kind: string;
  signerUrl: string;
  summary?: Record<string, unknown>;
  createdAt: string;
  cancelled?: boolean;
};

export type HirePhase = "none" | "quoting" | "offered" | "funded" | "working" | "delivered" | "settled";

const HIRE_RANK: Record<HirePhase, number> = {
  none: 0,
  quoting: 1,
  offered: 2,
  funded: 3,
  working: 4,
  delivered: 5,
  settled: 6,
};

export function mergeHirePhase(current: HirePhase | undefined, next: HirePhase): HirePhase {
  if (!current || current === "none") return next;
  if (next === "none") return "none";
  return HIRE_RANK[next] >= HIRE_RANK[current] ? next : current;
}

export type ConversationState = {
  id: string;
  source?: "termix" | "local";
  wallet?: Address;
  geoConfirmed: boolean;
  userConfirmed: boolean;
  pendingAction?: string;
  hirePhase?: HirePhase;
  lastOrderId?: string;
  lastOrderStatus?: string;
  lastOfferId?: string;
  lastOfferHint?: string;
  pendingEmptyDelivery?: boolean;
  lastDueWarnAt?: string;
  lastQuote?: PendingQuote;
  lastLp?: PendingLp;
  lastLpCompare?: CompareLpResult;
  lastIntent?: LastIntent;
  turns?: ChatTurn[];
  seenMessageIds?: string[];
  conversationKind?: string;
  buyer?: { accountId?: string; handle?: string; displayName?: string };
  preference?: string;
  updatedAt: string;
};

export function canCreateDefiIntent(state: ConversationState): boolean {
  if (state.source !== "termix") return true;
  return state.hirePhase === "working";
}

const MAX_TURNS = 24;
const MAX_SEEN = 200;
const MAX_TURN_CHARS = 4000;

export class ConversationStore {
  constructor(private dir: string) {}

  private file(id: string) {
    return join(this.dir, `${safeId(id)}.json`);
  }

  get(id: string): ConversationState {
    const p = this.file(id);
    if (!existsSync(p)) {
      return {
        id,
        geoConfirmed: false,
        userConfirmed: false,
        updatedAt: new Date().toISOString(),
      };
    }
    const raw = JSON.parse(readFileSync(p, "utf8")) as ConversationState;
    return { ...raw, id: raw.id || id };
  }

  save(state: ConversationState) {
    state.updatedAt = new Date().toISOString();
    writeFileSync(this.file(state.id), JSON.stringify(state, null, 2));
  }

  alreadySeen(id: string, messageId: string): boolean {
    if (!messageId) return false;
    return (this.get(id).seenMessageIds ?? []).includes(messageId);
  }

  ingestUserText(id: string, text: string): ConversationState {
    const s = this.get(id);
    s.geoConfirmed = latchGeoConfirm(s.geoConfirmed, text);
    s.userConfirmed = latchUserConfirm(s.userConfirmed, text);
    const wallet = text.match(/0x[a-fA-F0-9]{40}/);
    if (wallet) s.wallet = getAddress(wallet[0]) as Address;
    this.save(s);
    return s;
  }

  /**
   * Termix inbox delivers only the new message (no thread history).
   * Persist slots + transcript under conversationId; messageId is the idempotency key.
   */
  ingestTermixMessage(msg: InboxMessage): { state: ConversationState; duplicate: boolean } {
    const id = msg.conversationId;
    if (this.alreadySeen(id, msg.messageId)) {
      return { state: this.get(id), duplicate: true };
    }
    const s = this.ingestUserText(id, msg.text ?? "");
    s.source = "termix";
    if (!s.hirePhase || s.hirePhase === "none") s.hirePhase = s.geoConfirmed ? "quoting" : "none";
    if (msg.conversationKind) s.conversationKind = msg.conversationKind;
    if (msg.orderId) s.lastOrderId = msg.orderId;
    if (msg.from) {
      s.buyer = {
        accountId: msg.from.accountId,
        handle: msg.from.handle,
        displayName: msg.from.displayName,
      };
      if (!s.wallet && msg.from.walletAddress && /^0x[a-fA-F0-9]{40}$/.test(msg.from.walletAddress)) {
        s.wallet = getAddress(msg.from.walletAddress) as Address;
      }
    }
    if (msg.orderId) this.seedFromSibling(s, msg.orderId);
    const seen = s.seenMessageIds ?? [];
    seen.push(msg.messageId);
    s.seenMessageIds = seen.slice(-MAX_SEEN);
    this.save(s);
    return { state: s, duplicate: false };
  }

  consumeConfirm(id: string) {
    const s = this.get(id);
    s.userConfirmed = false;
    this.save(s);
    return s;
  }

  clearPending(id: string) {
    const s = this.get(id);
    delete s.lastQuote;
    delete s.lastLp;
    this.save(s);
    return s;
  }

  cancelPending(id: string) {
    const s = this.get(id);
    s.userConfirmed = false;
    delete s.lastQuote;
    delete s.lastLp;
    if (s.lastIntent) s.lastIntent = { ...s.lastIntent, cancelled: true };
    this.save(s);
    return s;
  }

  rememberIntent(id: string, intent: Omit<LastIntent, "createdAt"> & { createdAt?: string }) {
    const s = this.get(id);
    s.lastIntent = {
      ...intent,
      createdAt: intent.createdAt ?? new Date().toISOString(),
    };
    this.save(s);
    return s;
  }

  private seedFromSibling(s: ConversationState, orderId: string) {
    const sibling = this.findSiblingByOrder(orderId, s.id);
    if (!sibling) return;
    if (!s.wallet && sibling.wallet) s.wallet = sibling.wallet;
    if (!s.geoConfirmed && sibling.geoConfirmed) s.geoConfirmed = true;
    if (!s.lastQuote && sibling.lastQuote) s.lastQuote = sibling.lastQuote;
    if (!s.lastIntent && sibling.lastIntent) s.lastIntent = sibling.lastIntent;
    if (!s.lastOfferId && sibling.lastOfferId) s.lastOfferId = sibling.lastOfferId;
    if (sibling.hirePhase) s.hirePhase = mergeHirePhase(s.hirePhase, sibling.hirePhase);
  }

  findByOrderId(orderId: string): ConversationState | undefined {
    return this.findSiblingByOrder(orderId, "");
  }

  list(): ConversationState[] {
    if (!existsSync(this.dir)) return [];
    const out: ConversationState[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      out.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ConversationState);
    }
    return out;
  }

  patchHire(
    id: string,
    patch: Partial<Pick<ConversationState, "hirePhase" | "lastOfferId" | "lastOrderId" | "lastOrderStatus">>,
    opts?: { replace?: boolean; clearOrder?: boolean },
  ) {
    const s = this.get(id);
    if (opts?.clearOrder) {
      delete s.lastOrderId;
      delete s.lastOrderStatus;
    }
    if (patch.lastOfferId) s.lastOfferId = patch.lastOfferId;
    if (patch.lastOrderId) s.lastOrderId = patch.lastOrderId;
    if (patch.lastOrderStatus) s.lastOrderStatus = patch.lastOrderStatus;
    if (patch.hirePhase) {
      s.hirePhase = opts?.replace ? patch.hirePhase : mergeHirePhase(s.hirePhase, patch.hirePhase);
    }
    this.save(s);
    return s;
  }

  startNewHire(id: string) {
    const s = this.get(id);
    delete s.lastOrderId;
    delete s.lastOrderStatus;
    delete s.lastOfferId;
    delete s.pendingEmptyDelivery;
    delete s.lastDueWarnAt;
    s.hirePhase = s.geoConfirmed ? "quoting" : "none";
    this.save(s);
    return s;
  }

  private findSiblingByOrder(orderId: string, exceptId: string): ConversationState | undefined {
    if (!existsSync(this.dir)) return undefined;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ConversationState;
      if (raw.id === exceptId || raw.lastOrderId !== orderId) continue;
      return raw;
    }
    return undefined;
  }

  appendTurn(id: string, role: ChatTurn["role"], content: string, messageId?: string) {
    const s = this.get(id);
    const turns = s.turns ?? [];
    turns.push({
      role,
      content: content.slice(0, MAX_TURN_CHARS),
      at: new Date().toISOString(),
      messageId,
    });
    s.turns = turns.slice(-MAX_TURNS);
    this.save(s);
    return s;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

/** Compact slot memory injected every LLM turn. Transcript is separate. */
export function formatRuntimeState(state: ConversationState): string {
  const snap = {
    conversationId: state.id,
    source: state.source ?? "local",
    conversationKind: state.conversationKind,
    geoConfirmed: state.geoConfirmed,
    userConfirmed: state.userConfirmed,
    wallet: state.wallet,
    buyer: state.buyer,
    lastQuote: state.lastQuote,
    lastLp: state.lastLp,
    lastLpCompare: state.lastLpCompare
      ? {
          token: state.lastLpCompare.token,
          highestApr: state.lastLpCompare.highestApr
            ? {
                quote: state.lastLpCompare.highestApr.quote,
                fee: state.lastLpCompare.highestApr.fee,
                feeLabel: state.lastLpCompare.highestApr.feeLabel,
                apr24hPct: state.lastLpCompare.highestApr.apr24hPct,
              }
            : undefined,
          thickest: state.lastLpCompare.thickest
            ? {
                quote: state.lastLpCompare.thickest.quote,
                fee: state.lastLpCompare.thickest.fee,
                feeLabel: state.lastLpCompare.thickest.feeLabel,
                tvlUsd: state.lastLpCompare.thickest.tvlUsd,
              }
            : undefined,
        }
      : undefined,
    hirePhase: state.hirePhase ?? "none",
    lastOrderId: state.lastOrderId,
    lastOrderStatus: state.lastOrderStatus,
    lastOfferId: state.lastOfferId,
    lastIntent: state.lastIntent
      ? { id: state.lastIntent.id, kind: state.lastIntent.kind, signerUrl: state.lastIntent.signerUrl }
      : undefined,
  };
  const lines = [
    "This is the Termix conversation memory card (persisted by conversationId). Inbox sends only the new message, no history. These slots plus recent turns are the context. Do not treat the user as new.",
    `Conversation state: ${JSON.stringify(snap)}`,
  ];
  lines.push(...hirePhaseLines(state));
  const defiReady = canCreateDefiIntent(state);
  if (state.lastQuote && !defiReady && state.source === "termix") {
    lines.push(
      `A swap was mentioned (${state.lastQuote.amountInUi} ${state.lastQuote.tokenIn} → ${state.lastQuote.tokenOut}) but hire is not in working yet. Do not create_swap_intent. Finish the Termix offer/checkout/accept first.`,
    );
  } else if (state.lastQuote) {
    const q = state.lastQuote;
    lines.push(
      `Pending swap: ${q.amountInUi} ${q.tokenIn} → ${q.tokenOut}. On confirm, call create_swap_intent with these params immediately. Do not re-ask buy vs sell or the amount.`,
    );
  } else if (state.lastLp?.collectTokenId) {
    lines.push(
      `Pending fee collect: NFT #${state.lastLp.collectTokenId}. On confirm, call create_lp_intent (collectTokenId) immediately. Do not re-ask the action type.`,
    );
  } else if (state.lastLp?.decreaseTokenId) {
    lines.push(
      `Pending withdraw: NFT #${state.lastLp.decreaseTokenId} ${state.lastLp.decreaseBps ?? 10000} bps. On confirm, call create_lp_intent immediately.`,
    );
  } else if (state.lastLp?.increaseTokenId && state.lastLp.amountTokenUi) {
    lines.push(
      `Pending increase: NFT #${state.lastLp.increaseTokenId} + ${state.lastLp.amountTokenUi} ${state.lastLp.token}. On confirm, call create_lp_intent immediately.`,
    );
  } else if (state.lastLp?.amountTokenUi || state.lastLp?.amountQuoteUi || state.lastLp?.budgetQuoteUi) {
    const lp = state.lastLp;
    const size = lp.budgetQuoteUi
      ? `budget ~ ${lp.budgetQuoteUi} ${lp.quote ?? "quote"}`
      : [lp.amountTokenUi && `${lp.amountTokenUi} ${lp.token}`, lp.amountQuoteUi && `${lp.amountQuoteUi} ${lp.quote ?? "quote"}`]
          .filter(Boolean)
          .join(" + ");
    const pool = [lp.quote, lp.fee != null ? `fee ${lp.fee}` : undefined].filter(Boolean).join(" ");
    lines.push(
      `Pending LP mint: ${size}${pool ? ` · ${pool}` : ""}. On confirm, call create_lp_intent with lastLp token/quote/fee. Do not re-ask the action type. Do not revert to the default USDT 2500 pool.`,
    );
  } else if (state.lastLpCompare) {
    const top = state.lastLpCompare.highestApr;
    lines.push(
      `Already compared ${state.lastLpCompare.token} V3 fee APR. After the user picks a tier (highest / WBNB / 0.25%) and an amount, write that quote+fee into lastLp then create_lp_intent.${
        top ? ` Current non-thin highest is about ${top.apr24hPct.toFixed(1)}% (${top.quote} ${top.feeLabel}).` : ""
      } Do not promise yield.`,
    );
  } else {
    lines.push(
      "No pending quote. If the user only says confirm with nothing pending, ask them to restate the token and amount in one sentence. Do not turn it into a questionnaire. On cancel, do not keep asking.",
    );
  }
  if (state.lastIntent?.cancelled) {
    lines.push("The last signer page was cancelled. Do not send that link again.");
  } else if (state.lastIntent?.signerUrl) {
    lines.push(`Most recent signer page (if they ask for the link, give this): ${state.lastIntent.signerUrl}`);
  }
  if (state.wallet) {
    lines.push(`Buyer wallet is already ${state.wallet}. Do not ask for 0x again unless they want to change it.`);
  }
  if (state.geoConfirmed) {
    lines.push("Geo declaration is done. Do not ask again.");
  }
  return lines.join("\n");
}

function hirePhaseLines(state: ConversationState): string[] {
  if (state.source !== "termix") {
    return [
      "This is a local /chat session, not a Termix hire. Do not call send_termix_offer, provider_accept_order, or submit_termix_delivery. After geo, quote and create_swap_intent / create_lp_intent on confirm as usual.",
    ];
  }
  const phase = state.hirePhase ?? "none";
  const draft = listingDraft();
  const fee = `${draft.basePrice} ${draft.currency}`;
  const guide: Record<HirePhase, string> = {
    none: `Termix hire has not started. After geo, explain that ${fee} is the service fee, then send_termix_offer when they ask for the standard quote.`,
    quoting:
      `Hire phase quoting. Explain ${fee} escrow is the service fee (not a stock purchase). If they ask for the standard offer / 请发标准报价 / 我要这个服务, call send_termix_offer. Do not create a swap or LP intent yet.`,
    offered:
      `Hire phase offered. Do NOT create a swap/LP intent. Tell them to accept the ${fee} offer card and pay Termix checkout. Do not ask what they want to test.`,
    funded:
      "Hire phase funded. Call provider_accept_order now. Then ask for the buyer 0x if missing. Do not create a DeFi signer page until accept lands.",
    working:
      "Hire phase working. Now quote whitelist DeFi and create_swap_intent / create_lp_intent after confirm. After the user broadcasts (or they ask to deliver), call submit_termix_delivery. Do not submit with confirmEmpty unless they said they want the report with no on-chain trade.",
    delivered:
      "Hire phase delivered. Ask the buyer to accept delivery and release escrow. Do not start a new free trading desk. Mention the 48h challenge window.",
    settled:
      "Hire phase settled. If they want another guided execution, call send_termix_offer (it will start a new hire). Do not reuse the old orderId.",
  };
  const extra = state.lastDueWarnAt
    ? ["Delivery window is closing. If they are finished or skipping the trade, ask them to 请交付 / 没做交易也交付."]
    : [];
  return [guide[phase], ...extra];
}
