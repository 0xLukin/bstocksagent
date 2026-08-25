import { createHash } from "node:crypto";
import type { TermixClient } from "./client.js";
import type { TxIntent } from "./types.js";

export async function listOrders(client: TermixClient, side?: "client" | "provider") {
  const q = side ? `?side=${side}` : "";
  return client.request<{ items?: unknown[] } | unknown[]>(`/api/v1/orders${q}`);
}

export async function getOrder(client: TermixClient, orderId: string) {
  return client.request<{
    id: string;
    status: string;
    deliveryDueAt?: string;
    challengeWindowEndsAt?: string;
    availableActions?: Record<string, boolean>;
  }>(`/api/v1/orders/${orderId}`);
}

export async function prepareProviderAccept(client: TermixClient, orderId: string) {
  return client.request<TxIntent>(`/api/v1/orders/${orderId}/provider-accept/prepare`, {
    method: "POST",
  });
}

export async function requestDeliveryUploadUrl(
  client: TermixClient,
  orderId: string,
  file: { fileName: string; contentType: string; sizeBytes: number },
) {
  return client.request<{ uploadUrl: string; s3Key: string; publicUrl?: string; url?: string }>(
    `/api/v1/orders/${orderId}/delivery/upload-url`,
    { method: "POST", body: JSON.stringify(file) },
  );
}

export async function registerArtifact(
  client: TermixClient,
  orderId: string,
  body: {
    s3Key: string;
    url: string;
    sha256: string;
    contentType: string;
    sizeBytes: number;
  },
) {
  return client.request<{ id: string }>(`/api/v1/orders/${orderId}/delivery/artifacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function submitDelivery(
  client: TermixClient,
  orderId: string,
  artifactIds: string[],
  note: string,
) {
  return client.request<TxIntent>(`/api/v1/orders/${orderId}/delivery/submit`, {
    method: "POST",
    body: JSON.stringify({ artifactIds, note }),
  });
}

export async function prepareClaimAfterTimeout(client: TermixClient, orderId: string) {
  return client.request<TxIntent>(`/api/v1/orders/${orderId}/claim-after-timeout/prepare`, {
    method: "POST",
  });
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function getOnchainTx(client: TermixClient, txHash: string) {
  return client.request<{ status?: string }>(`/api/v1/onchain/tx/${txHash}`, { auth: "session" });
}
