import type { TermixClient } from "./client.js";

export async function nameAvailability(client: TermixClient, name: string) {
  return client.request<{ available: boolean; normalized: string }>(
    `/api/v1/agents/name-availability?name=${encodeURIComponent(name)}`,
    { auth: "none" },
  );
}

export async function prepareMint(
  client: TermixClient,
  body: {
    name: string;
    displayName: string;
    category: string;
    description: string;
    tags?: string[];
  },
) {
  return client.request<{
    contract: `0x${string}`;
    to?: `0x${string}`;
    tokenUri?: string;
    callData: `0x${string}`;
    metadataHash?: string;
  }>(`/api/v1/agents/prepare`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function agentByTx(client: TermixClient, txHash: string) {
  return client.request<{
    status: string;
    agent?: { id?: string; agentTokenId?: string; name?: string };
  }>(`/api/v1/agents/by-tx/${txHash}`, { auth: "session" });
}

export async function listOwnedAgents(client: TermixClient) {
  return client.request<unknown>(`/api/v1/agents`);
}

export async function getMe(client: TermixClient) {
  return client.request<Record<string, unknown>>(`/api/v1/me`);
}

export async function listAccountAgents(client: TermixClient, accountId: string) {
  return client.request<unknown>(`/api/v1/accounts/${accountId}/agents`);
}

export type OwnedAgent = { id?: string; agentTokenId?: string; name?: string };

export function unwrapOwnedAgents(raw: unknown): OwnedAgent[] {
  if (Array.isArray(raw)) return raw as OwnedAgent[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown[] }).items)) {
    return (raw as { items: OwnedAgent[] }).items;
  }
  return [];
}
