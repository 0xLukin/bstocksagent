import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeliveryReport, renderMarkdown } from "@bstocks/report";
import {
  broadcastIntent,
  getConversation,
  getOffer,
  getOnchainTx,
  getOrder,
  listingDraft,
  listConversationMessages,
  listOrders,
  prepareProviderAccept,
  registerArtifact,
  requestDeliveryUploadUrl,
  requireWalletKey,
  sendConversationOffer,
  sha256Hex,
  submitDelivery,
  withdrawOffer,
  TermixHttpError,
  type TermixClient,
} from "@bstocks/termix";
import {
  type ConversationState,
  type ConversationStore,
  type HirePhase,
} from "./conversation.js";

export type HireCtx = {
  conversation: ConversationState;
  conversations: ConversationStore;
  intents: { list: () => Array<{ conversationId?: string; kind: string; txHashes?: string[] }> };
  termix?: TermixClient;
  agentId?: string;
  dataDir: string;
};

export function phaseFromOrderStatus(status: string): HirePhase | undefined {
  const s = status.toUpperCase();
  if (s === "SETTLED" || s === "COMPLETED") return "settled";
  if (s === "DELIVERED") return "delivered";
  if (s === "IN_PROGRESS" || s === "ACCEPTED" || s === "ACTIVE") return "working";
  if (s === "PENDING_ACCEPT" || s === "FUNDED" || s === "PENDING") return "funded";
  if (s === "CANCELLED" || s === "CANCELED" || s === "EXPIRED") return "none";
  return undefined;
}

export function isSystemHireEvent(text: string, orderId?: string, kind?: string): boolean {
  if (orderId && !text.trim()) return true;
  if (kind && /ORDER|FUNDED|DELIVER|CHECKOUT|ESCROW/i.test(kind)) return true;
  return /订单已开通|已交付|已接受送货|Paid provider|Order opened|Delivery accepted/i.test(text);
}

export function serviceFeeLabel() {
  const draft = listingDraft();
  return `${draft.basePrice} ${draft.currency}`;
}

export function hireEventReply(state: ConversationState): string {
  const phase = state.hirePhase ?? "none";
  const fee = serviceFeeLabel();
  const replies: Record<HirePhase, string> = {
    none: `This listing is a guided bStocks / Pancake V3 execution plus a written report. Service fee is ${fee} in Termix escrow — that is not a stock purchase. Confirm you are not in the US or a restricted region, then ask for the standard offer.`,
    quoting: `${fee} is the Termix service fee (escrow), not the size of a bStock trade. Reply 「请发标准报价」 / send the standard offer and I will send the ${fee} card. After you accept and pay checkout, I accept the order and we do the on-chain trade on the signer page.`,
    offered: `I sent the ${fee} Standard offer. Accept that card and complete Termix checkout (approve + escrow). I cannot create a DeFi signer page until the order is funded and I have accepted it.`,
    funded: "Payment received. I am accepting the order on-chain now. After that, send your BSC wallet if needed and the token + amount (e.g. 用 0.01 USDC 买英伟达).",
    working:
      "Order is in progress. Say the whitelist token and amount. After you check the quote, reply 确认执行 for the signer page. When the broadcast is done (or you want to close the job with no tx), say 请交付.",
    delivered: `Delivery is submitted. Accept delivery on Termix to release the ${fee} escrow. If you do nothing, the challenge window is 48 hours, then I can claimAfterTimeout.`,
    settled: `This order is settled. Say 「请发标准报价」 / 再来一单 if you want another guided execution.`,
  };
  return replies[phase];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickStr(v: unknown, ...keys: string[]): string | undefined {
  const obj = asRecord(v);
  for (const k of keys) {
    const x = obj[k];
    if (typeof x === "string" && x) return x;
    if (typeof x === "number") return String(x);
  }
  for (const nested of ["offer", "current", "revision", "order", "agent", "data"]) {
    if (obj[nested]) {
      const inner = pickStr(obj[nested], ...keys);
      if (inner) return inner;
    }
  }
  return undefined;
}

export function parseOfferRecord(raw: unknown) {
  const root = asRecord(raw);
  const offer = asRecord(root.offer).id ? asRecord(root.offer) : root;
  const current = asRecord(offer.current).id ? asRecord(offer.current) : asRecord(offer.revision);
  return {
    id: pickStr(offer, "id", "offerId"),
    status: pickStr(offer, "status"),
    revisionId: pickStr(current, "id") ?? pickStr(offer, "revisionId", "acceptedRevisionId"),
    price: pickStr(current, "price") ?? pickStr(offer, "price"),
    currency: pickStr(current, "currency") ?? pickStr(offer, "currency"),
  };
}

export function offerMatchesListing(offer: { price?: string; currency?: string }) {
  const draft = listingDraft();
  const price = Number(offer.price);
  const want = Number(draft.basePrice);
  if (!Number.isFinite(price) || !Number.isFinite(want) || price !== want) return false;
  const currency = (offer.currency ?? draft.currency).toUpperCase();
  return currency === draft.currency.toUpperCase();
}

function walkOffers(raw: unknown): unknown[] {
  const obj = asRecord(raw);
  const bags = [obj.offers, obj.items, asRecord(obj.offer).id ? [obj.offer] : null];
  const out: unknown[] = [];
  for (const bag of bags) {
    if (Array.isArray(bag)) out.push(...bag);
  }
  return out;
}

function offerIdsInText(text: string): string[] {
  const named = [
    ...text.matchAll(/Offer (cm[a-z0-9]{20,})/gi),
    ...text.matchAll(/"offerId":"(cm[a-z0-9]{20,})"/g),
  ].map((m) => m[1]!);
  if (named.length) return [...new Set(named)];
  return [...text.matchAll(/\b(cm[a-z0-9]{20,})\b/g)].map((m) => m[1]!);
}

function isConflictError(err: unknown): boolean {
  if (err instanceof TermixHttpError) {
    return err.status === 409 || /active quote already exists/i.test(err.body);
  }
  return err instanceof Error && /409|active quote already exists/i.test(err.message);
}

function isOpenOffer(status?: string) {
  return !/WITHDRAWN|EXPIRED|DECLINED/i.test(status ?? "ACTIVE");
}

function pickBestOffer<T extends { id?: string; status?: string; price?: string; currency?: string }>(
  offers: T[],
): T | undefined {
  const open = offers.filter((o) => o.id && isOpenOffer(o.status));
  const matching = open.filter((o) => offerMatchesListing(o));
  const pool = matching.length ? matching : [];
  return (
    pool.find((o) => /ACTIVE/i.test(o.status ?? "")) ??
    pool.find((o) => /ACCEPTED|LOCKED/i.test(o.status ?? "")) ??
    pool[0]
  );
}

async function collectOffers(client: TermixClient, conversationId: string, hintId?: string) {
  const found: Array<ReturnType<typeof parseOfferRecord>> = [];
  const tryId = async (id?: string) => {
    if (!id) return;
    const idx = found.findIndex((o) => o.id === id);
    if (idx >= 0 && found[idx]?.price) return;
    try {
      const parsed = parseOfferRecord(await getOffer(client, id));
      if (idx >= 0) found[idx] = parsed;
      else found.push(parsed);
    } catch {
      /* not an offer id */
    }
  };
  await tryId(hintId);
  const convo = await getConversation(client, conversationId);
  for (const row of walkOffers(convo).map(parseOfferRecord)) {
    if (row.id && !found.some((o) => o.id === row.id)) found.push(row);
  }
  try {
    const listed = await client.request(`/api/v1/conversations/${conversationId}/offers`);
    for (const row of walkOffers(listed).map(parseOfferRecord)) {
      if (row.id && !found.some((o) => o.id === row.id)) found.push(row);
    }
  } catch {
    /* GET may 404/405 */
  }
  const msgs = await listConversationMessages(client, conversationId);
  for (const id of offerIdsInText(JSON.stringify(msgs))) await tryId(id);
  for (const row of found) await tryId(row.id);
  return found;
}

export async function findLiveOffer(client: TermixClient, conversationId: string, hintId?: string) {
  return pickBestOffer(await collectOffers(client, conversationId, hintId));
}

async function withdrawMismatchedActive(client: TermixClient, conversationId: string, hintId?: string) {
  const found = await collectOffers(client, conversationId, hintId);
  for (const offer of found) {
    if (!offer.id || !/ACTIVE/i.test(offer.status ?? "") || offerMatchesListing(offer)) continue;
    try {
      await withdrawOffer(client, offer.id);
      console.log(`[hire] withdrew leftover offer ${offer.id} price=${offer.price ?? "?"}`);
    } catch (err) {
      console.warn(`[hire] withdraw ${offer.id} failed`, err instanceof Error ? err.message : err);
    }
  }
}

function applyHire(
  ctx: HireCtx,
  patch: Parameters<ConversationStore["patchHire"]>[1],
  opts?: { replace?: boolean; clearOrder?: boolean },
) {
  const next = ctx.conversations.patchHire(ctx.conversation.id, patch, opts);
  ctx.conversation = next;
  return next;
}

function isClosedStatus(status?: string) {
  const phase = status ? phaseFromOrderStatus(status) : undefined;
  return phase === "settled" || phase === "none";
}

export async function refreshHireFromTermix(ctx: HireCtx): Promise<ConversationState> {
  if (!ctx.termix) return ctx.conversation;
  try {
    const live = await findLiveOffer(ctx.termix, ctx.conversation.id, ctx.conversation.lastOfferId);
    const offerRaw = live?.id ? await getOffer(ctx.termix, live.id).catch(() => ({})) : {};
    const offerOrderId = pickStr(offerRaw, "orderId") ?? pickStr(asRecord(offerRaw).order, "id", "orderId");
    const convo = await getConversation(ctx.termix, ctx.conversation.id);
    const convoOrderId = pickStr(convo, "orderId") ?? pickStr(asRecord(convo).order, "id", "orderId");

    if (live?.id && /ACTIVE/i.test(live.status ?? "") && !offerOrderId) {
      applyHire(ctx, { lastOfferId: live.id, hirePhase: "offered" }, { replace: true, clearOrder: true });
      ctx.conversation = ctx.conversations.get(ctx.conversation.id);
      return ctx.conversation;
    }

    const orderId = offerOrderId ?? convoOrderId ?? ctx.conversation.lastOrderId;
    if (live?.id) applyHire(ctx, { lastOfferId: live.id });
    if (orderId) {
      const order = await getOrder(ctx.termix, orderId);
      const phase = phaseFromOrderStatus(order.status);
      applyHire(ctx, {
        lastOrderId: order.id,
        lastOrderStatus: order.status,
        ...(phase ? { hirePhase: phase } : {}),
      });
    }
  } catch {
    /* conversation may not exist on /chat */
  }
  ctx.conversation = ctx.conversations.get(ctx.conversation.id);
  return ctx.conversation;
}

export async function sendStandardOffer(ctx: HireCtx, message?: string) {
  if (!ctx.termix || !ctx.agentId) {
    return { error: "termix_not_configured" as const };
  }
  if (!ctx.conversation.geoConfirmed) {
    throw new Error("Geo not confirmed. Ask the user to declare they are not in the US or a restricted region.");
  }
  const phase = ctx.conversation.hirePhase ?? "none";
  if (phase === "working" || phase === "funded") {
    return {
      error: "hire_in_progress" as const,
      message: "This hire is already funded or in progress. Say the token and amount, or 请交付 when you want the report.",
    };
  }
  if (phase === "delivered" && !isClosedStatus(ctx.conversation.lastOrderStatus)) {
    return {
      error: "order_open" as const,
      message: `Delivery is already submitted. Accept delivery on Termix to release the ${serviceFeeLabel()} escrow. After it settles, ask for a new standard offer.`,
    };
  }
  await withdrawMismatchedActive(ctx.termix, ctx.conversation.id, ctx.conversation.lastOfferId);
  const matching = await findLiveOffer(ctx.termix, ctx.conversation.id, ctx.conversation.lastOfferId);
  if (
    phase === "settled" ||
    isClosedStatus(ctx.conversation.lastOrderStatus) ||
    !matching ||
    !/ACTIVE/i.test(matching.status ?? "")
  ) {
    ctx.conversation = ctx.conversations.startNewHire(ctx.conversation.id);
  }
  const draft = listingDraft();
  const body = {
    providerAgentId: ctx.agentId,
    price: draft.basePrice,
    currency: draft.currency,
    deliveryDays: draft.deliveryDays,
    scope: draft.packages[0]?.scope ?? "Whitelist bStocks / PancakeSwap V3 execution plus a written report.",
    message:
      message ??
      `Standard listing offer: ${serviceFeeLabel()} service fee in Termix escrow. On-chain trades are signed by you on the signer page after I accept the order.`,
    proofMethod: "manual",
    settlementType: "escrow" as const,
  };
  try {
    const res = await sendConversationOffer(ctx.termix, ctx.conversation.id, body);
    const parsed = parseOfferRecord(res);
    applyHire(ctx, { hirePhase: "offered", lastOfferId: parsed.id });
    return { ok: true as const, offer: res, offerId: parsed.id };
  } catch (err) {
    if (isConflictError(err)) {
      await withdrawMismatchedActive(ctx.termix, ctx.conversation.id, ctx.conversation.lastOfferId);
      const live = await findLiveOffer(ctx.termix, ctx.conversation.id, ctx.conversation.lastOfferId);
      if (live?.id && offerMatchesListing(live)) {
        applyHire(ctx, { hirePhase: "offered", lastOfferId: live.id });
        return { ok: true as const, offer: live, offerId: live.id, reused: true };
      }
      return {
        error: "stale_offer" as const,
        message: `A leftover Termix quote is blocking the ${serviceFeeLabel()} card. Decline the old card on Termix, then ask again.`,
      };
    }
    throw err;
  }
}

export async function broadcastProviderAccept(client: TermixClient, orderId: string) {
  try {
    const intent = await prepareProviderAccept(client, orderId);
    const hash = await broadcastIntent(intent, requireWalletKey());
    for (let i = 0; i < 8; i++) {
      const st = await getOnchainTx(client, hash);
      if (String(st.status ?? "").toUpperCase() === "CONFIRMED") break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    return hash;
  } catch (err) {
    if (isConflictError(err) || (err instanceof Error && /not awaiting provider acceptance/i.test(err.message))) {
      return "already-accepted";
    }
    throw err;
  }
}

export async function acceptFundedOrder(ctx: HireCtx, orderId = ctx.conversation.lastOrderId) {
  if (!ctx.termix) return { error: "termix_not_configured" as const };
  if (!orderId) return { error: "no_order" as const, message: "No Termix orderId yet." };
  const hash = await broadcastProviderAccept(ctx.termix, orderId);
  applyHire(ctx, { lastOrderId: orderId, hirePhase: "working", lastOrderStatus: "IN_PROGRESS" });
  return { ok: true as const, orderId, txHash: hash };
}

export async function submitHireDelivery(
  ctx: HireCtx,
  orderId = ctx.conversation.lastOrderId,
  opts?: { confirmEmpty?: boolean },
) {
  if (!ctx.termix) return { error: "termix_not_configured" as const };
  if (!orderId) return { error: "no_order" as const };
  const reportDir = join(ctx.dataDir, "reports");
  mkdirSync(reportDir, { recursive: true });
  const txs: Array<{ kind: string; hash: string; note?: string }> = [];
  if (ctx.conversation.lastIntent && !ctx.conversation.lastIntent.cancelled) {
    txs.push({
      kind: ctx.conversation.lastIntent.kind,
      hash: "",
      note: ctx.conversation.lastIntent.signerUrl,
    });
  }
  for (const intent of ctx.intents.list().filter((i) => i.conversationId === ctx.conversation.id)) {
    for (const hash of intent.txHashes ?? []) {
      txs.push({ kind: intent.kind, hash });
    }
  }
  const onchain = txs.filter((t) => t.hash);
  if (!onchain.length && !opts?.confirmEmpty) {
    return {
      error: "delivery_needs_confirm" as const,
      message:
        "No on-chain DeFi hash is recorded yet (a signer page is not a fill). Reply 「没做交易也交付」 if you want the written report anyway, or broadcast first then 请交付.",
    };
  }
  const report = buildDeliveryReport({
    title: "bStocks / Pancake V3 delivery report",
    userAddress: ctx.conversation.wallet,
    orderId,
    txs: txs.filter((t) => t.hash || t.note),
    notes: [
      "Generated by the agent for this Termix hire.",
      onchain.length
        ? `${onchain.length} on-chain hash(es) recorded.`
        : "No DeFi broadcast was recorded. This report closes the Termix hire only.",
      ctx.conversation.lastIntent?.signerUrl ? `Signer: ${ctx.conversation.lastIntent.signerUrl}` : "No signer page in this hire.",
    ],
  });
  const md = renderMarkdown(report);
  const file = join(reportDir, `hire-${orderId}.md`);
  writeFileSync(file, md);
  const buf = Buffer.from(md);
  const sha = sha256Hex(buf);
  const up = await requestDeliveryUploadUrl(ctx.termix, orderId, {
    fileName: `hire-${orderId}.md`,
    contentType: "text/markdown",
    sizeBytes: buf.length,
  });
  await fetch(up.uploadUrl, { method: "PUT", body: buf, headers: { "content-type": "text/markdown" } });
  const art = await registerArtifact(ctx.termix, orderId, {
    s3Key: up.s3Key,
    url: up.publicUrl ?? up.url ?? up.uploadUrl,
    sha256: sha,
    contentType: "text/markdown",
    sizeBytes: buf.length,
  });
  const intent = await submitDelivery(ctx.termix, orderId, [art.id], "bStocks / Pancake V3 delivery report");
  const hash = await broadcastIntent(intent, requireWalletKey());
  applyHire(ctx, { lastOrderId: orderId, hirePhase: "delivered", lastOrderStatus: "DELIVERED" });
  const saved = ctx.conversations.get(ctx.conversation.id);
  delete saved.pendingEmptyDelivery;
  ctx.conversations.save(saved);
  ctx.conversation = saved;
  return { ok: true as const, orderId, txHash: hash, file, artifactId: art.id };
}

export async function acceptPendingProviderOrders(client: TermixClient, conversations?: ConversationStore) {
  const raw = await listOrders(client, "provider");
  const items = (Array.isArray(raw) ? raw : raw.items ?? []) as Array<{ id?: string; status?: string }>;
  const accepted: string[] = [];
  for (const o of items) {
    if (!o.id) continue;
    const phase = phaseFromOrderStatus(o.status ?? "");
    if (phase !== "funded") continue;
    try {
      const hash = await broadcastProviderAccept(client, o.id);
      accepted.push(o.id);
      if (conversations) {
        const detail = await getOrder(client, o.id).catch(() => ({ id: o.id, offerId: undefined as string | undefined }));
        const offerId = pickStr(detail, "offerId");
        const matches = conversations
          .list()
          .filter((c) => c.lastOrderId === o.id || (offerId && c.lastOfferId === offerId));
        for (const conv of matches) {
          conversations.patchHire(conv.id, {
            lastOrderId: o.id,
            hirePhase: "working",
            lastOrderStatus: "IN_PROGRESS",
          });
        }
      }
      console.log(`[hire] provider-accept ${o.id} tx=${hash}`);
    } catch (err) {
      console.error(`[hire] provider-accept ${o.id}`, err instanceof Error ? err.message : err);
    }
  }
  return accepted;
}
