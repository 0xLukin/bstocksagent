import {
  getOrder,
  listOrders,
  prepareClaimAfterTimeout,
  broadcastIntent,
  TermixClient,
  walletLogin,
} from "@bstocks/termix";
import type { ConversationStore } from "./conversation.js";
import { acceptPendingProviderOrders, phaseFromOrderStatus } from "./hire.js";

/**
 * Termix has NO auto-settle worker.
 * Accept funded orders, warn on deliveryDueAt, claimAfterTimeout after challengeWindowEndsAt.
 */
export function startOrderWatchdog(conversations?: ConversationStore, intervalMs = 60_000) {
  if (!process.env.WALLET_KEY) {
    console.warn("[watchdog] WALLET_KEY unset — claimAfterTimeout cron idle.");
    return;
  }

  const tick = async () => {
    const client = new TermixClient();
    try {
      await walletLogin(client);
      await acceptPendingProviderOrders(client, conversations);
      const raw = await listOrders(client, "provider");
      const items = (Array.isArray(raw) ? raw : raw.items ?? []) as Array<{
        id: string;
        status: string;
        deliveryDueAt?: string;
        challengeWindowEndsAt?: string;
      }>;
      const now = Date.now();
      for (const o of items) {
        if (o.deliveryDueAt) {
          const due = Date.parse(o.deliveryDueAt);
          if (due < now && (o.status === "FUNDED" || o.status === "IN_PROGRESS")) {
            console.warn(`[watchdog] deliveryDueAt passed for ${o.id} status=${o.status} — anyone can cancelExpired`);
          } else if (due - now < 12 * 3600_000 && due > now && (o.status === "FUNDED" || o.status === "IN_PROGRESS")) {
            const conv = conversations?.findByOrderId(o.id);
            if (conv && conversations && !conv.lastDueWarnAt) {
              conv.lastDueWarnAt = new Date().toISOString();
              conversations.save(conv);
              console.warn(`[watchdog] delivery due within 12h for ${o.id} — next buyer message should ask 请交付`);
            }
          }
        }
        const phase = phaseFromOrderStatus(o.status);
        if (phase === "delivered" && o.challengeWindowEndsAt && Date.parse(o.challengeWindowEndsAt) < now) {
          try {
            const intent = await prepareClaimAfterTimeout(client, o.id);
            const hash = await broadcastIntent(intent);
            console.log(`[watchdog] claimAfterTimeout ${o.id} tx=${hash}`);
            const conv = conversations?.findByOrderId(o.id);
            if (conv && conversations) {
              conversations.patchHire(conv.id, {
                hirePhase: "settled",
                lastOrderStatus: "SETTLED",
              });
            }
          } catch (err) {
            console.error(`[watchdog] claim ${o.id} failed`, err instanceof Error ? err.message : err);
          }
        }
        if (o.id) {
          try {
            await getOrder(client, o.id);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error("[watchdog]", err instanceof Error ? err.message : err);
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}
