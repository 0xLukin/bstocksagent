import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import type { CompareLpResult } from "@bstocks/chain";
import { latchGeoConfirm, latchUserConfirm } from "@bstocks/risk";
import type { InboxMessage } from "@bstocks/termix";

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

export type ConversationState = {
  id: string;
  source?: "termix" | "local";
  wallet?: Address;
  geoConfirmed: boolean;
  userConfirmed: boolean;
  pendingAction?: string;
  lastOrderId?: string;
  lastOfferHint?: string;
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
    lastOrderId: state.lastOrderId,
    lastIntent: state.lastIntent
      ? { id: state.lastIntent.id, kind: state.lastIntent.kind, signerUrl: state.lastIntent.signerUrl }
      : undefined,
  };
  const lines = [
    "这是本 Termix 对话的记忆卡（按 conversationId 持久化）。Termix inbox 每条只有新消息，没有历史；以下槽位和最近对话才是上下文。不要把用户当成第一次来。",
    `当前对话状态：${JSON.stringify(snap)}`,
  ];
  if (state.lastQuote) {
    const q = state.lastQuote;
    lines.push(
      `待执行兑换：${q.amountInUi} ${q.tokenIn} → ${q.tokenOut}。用户说「确认」后必须立即 create_swap_intent（用这组参数），禁止再问买还是卖、禁止再要金额。`,
    );
  } else if (state.lastLp?.collectTokenId) {
    lines.push(
      `待收取手续费：NFT #${state.lastLp.collectTokenId}。用户说「确认」后必须立即 create_lp_intent（collectTokenId），禁止再问操作类型。`,
    );
  } else if (state.lastLp?.decreaseTokenId) {
    lines.push(
      `待撤出仓位：NFT #${state.lastLp.decreaseTokenId} ${state.lastLp.decreaseBps ?? 10000} bps。用户说「确认」后必须立即 create_lp_intent。`,
    );
  } else if (state.lastLp?.increaseTokenId && state.lastLp.amountTokenUi) {
    lines.push(
      `待加仓：NFT #${state.lastLp.increaseTokenId} + ${state.lastLp.amountTokenUi} ${state.lastLp.token}。用户说「确认」后必须立即 create_lp_intent。`,
    );
  } else if (state.lastLp?.amountTokenUi || state.lastLp?.amountQuoteUi || state.lastLp?.budgetQuoteUi) {
    const lp = state.lastLp;
    const size = lp.budgetQuoteUi
      ? `预算约 ${lp.budgetQuoteUi} USDT`
      : [lp.amountTokenUi && `${lp.amountTokenUi} ${lp.token}`, lp.amountQuoteUi && `${lp.amountQuoteUi} USDT`]
          .filter(Boolean)
          .join(" + ");
    const pool = [lp.quote, lp.fee != null ? `fee ${lp.fee}` : undefined].filter(Boolean).join(" ");
    lines.push(
      `待执行加池：${size}${pool ? ` · ${pool}` : ""}。用户说「确认」后必须立即 create_lp_intent（用记忆卡 lastLp 的 token/quote/fee），禁止再问操作类型、禁止改回默认 USDT 2500。`,
    );
  } else if (state.lastLpCompare) {
    const top = state.lastLpCompare.highestApr;
    lines.push(
      `已查过 ${state.lastLpCompare.token} 的 V3 池费率年化。用户指定某一档（最高 / WBNB / 0.25%）并给出金额后，必须按该 quote+fee 写入 lastLp 再 create_lp_intent。${
        top ? `当前非薄池最高约 ${top.apr24hPct.toFixed(1)}%（${top.quote} ${top.feeLabel}）。` : ""
      }不要承诺收益。`,
    );
  } else {
    lines.push(
      "当前没有待执行报价。用户只说「确认」且无待执行报价时，请对方用一句话重述标的和金额，不要展开成问卷。用户说「取消」时不要再追问。",
    );
  }
  if (state.lastIntent?.cancelled) {
    lines.push("上一笔签名页已取消，不要再发那个链接。");
  } else if (state.lastIntent?.signerUrl) {
    lines.push(`最近已生成的签名页（用户问「链接呢」就直接给）：${state.lastIntent.signerUrl}`);
  }
  if (state.wallet) {
    lines.push(`买家钱包已记录 ${state.wallet}，不要再向他要一遍 0x，除非他要换地址。`);
  }
  if (state.geoConfirmed) {
    lines.push("地理声明已完成，不要再要求重复声明。");
  }
  return lines.join("\n");
}
