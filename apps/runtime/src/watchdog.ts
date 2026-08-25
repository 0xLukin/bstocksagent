import {
  getOrder,
  listOrders,
  prepareClaimAfterTimeout,
  broadcastIntent,
  TermixClient,
  walletLogin,
} from "@bstocks/termix";

/**
 * Termix has NO auto-settle worker.
 * Watch deliveryDueAt (warn) and claimAfterTimeout after challengeWindowEndsAt.
 */
export function startOrderWatchdog(intervalMs = 60_000) {
  if (!process.env.WALLET_KEY) {
    console.warn("[watchdog] WALLET_KEY unset — claimAfterTimeout cron idle.");
    return;
  }

  const tick = async () => {
    const client = new TermixClient();
    try {
      await walletLogin(client);
      const raw = await listOrders(client, "provider");
      const items = (Array.isArray(raw) ? raw : raw.items ?? []) as Array<{
        id: string;
        status: string;
        deliveryDueAt?: string;
        challengeWindowEndsAt?: string;
      }>;
      const now = Date.now();
      for (const o of items) {
        if (o.deliveryDueAt && Date.parse(o.deliveryDueAt) < now && (o.status === "FUNDED" || o.status === "IN_PROGRESS")) {
          console.warn(`[watchdog] deliveryDueAt passed for ${o.id} status=${o.status} — anyone can cancelExpired`);
        }
        if (o.status === "DELIVERED" && o.challengeWindowEndsAt && Date.parse(o.challengeWindowEndsAt) < now) {
          try {
            const intent = await prepareClaimAfterTimeout(client, o.id);
            const hash = await broadcastIntent(intent);
            console.log(`[watchdog] claimAfterTimeout ${o.id} tx=${hash}`);
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
