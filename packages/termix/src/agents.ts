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
  return client.request<{ status: string; agent?: { id: string; name?: string } }>(
    `/api/v1/agents/by-tx/${txHash}`,
    { auth: "session" },
  );
}

export async function listOwnedAgents(client: TermixClient) {
  return client.request<unknown>(`/api/v1/agents`);
}
