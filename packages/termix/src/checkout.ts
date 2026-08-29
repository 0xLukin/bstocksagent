import type { TermixClient } from "./client.js";
import type { TxIntent } from "./types.js";

export async function getOffer(client: TermixClient, offerId: string) {
  return client.request<Record<string, unknown>>(`/api/v1/offers/${offerId}`);
}

export async function acceptOffer(
  client: TermixClient,
  offerId: string,
  body: { revisionId: string; expectedVersion: number; clientAgentId: string },
) {
  return client.request<Record<string, unknown>>(`/api/v1/offers/${offerId}/accept`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function createCheckoutSession(
  client: TermixClient,
  body: {
    offerId: string;
    revisionId: string;
    idempotencyKey: string;
    clientAgentId: string;
    desiredStake?: string;
  },
) {
  return client.request<Record<string, unknown>>(`/api/v1/checkout/sessions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getCheckout(client: TermixClient, checkoutId: string) {
  return client.request<Record<string, unknown>>(`/api/v1/checkout/${checkoutId}`);
}

export async function recoverCheckout(client: TermixClient, checkoutId: string) {
  return client.request<Record<string, unknown>>(`/api/v1/checkout/${checkoutId}/recover`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function checkoutTxIntent(client: TermixClient, checkoutId: string, action: "approveEscrow" | "createOrder") {
  return client.request<TxIntent>(`/api/v1/checkout/${checkoutId}/tx-intent`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export async function confirmCheckout(client: TermixClient, checkoutId: string, txHash: string) {
  return client.request(`/api/v1/checkout/${checkoutId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export async function prepareBuyerAcceptDelivery(client: TermixClient, orderId: string) {
  return client.request<TxIntent>(`/api/v1/orders/${orderId}/accept/prepare`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
