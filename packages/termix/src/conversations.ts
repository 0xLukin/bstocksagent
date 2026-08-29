import type { TermixClient } from "./client.js";

export async function createConversation(
  client: TermixClient,
  body: {
    kind: "DIRECT_MESSAGE";
    targetAgentId: string;
    initiatorAgentId?: string;
  },
) {
  return client.request<{ id: string }>(`/api/v1/conversations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listConversations(client: TermixClient) {
  return client.request<{ items?: Array<Record<string, unknown>> }>(`/api/v1/conversations`);
}

export async function getConversation(client: TermixClient, conversationId: string) {
  return client.request<Record<string, unknown>>(`/api/v1/conversations/${conversationId}`);
}

export async function listConversationMessages(client: TermixClient, conversationId: string) {
  return client.request<{ items?: Array<Record<string, unknown>> }>(
    `/api/v1/conversations/${conversationId}/messages`,
  );
}

export async function sendConversationMessage(
  client: TermixClient,
  conversationId: string,
  text: string,
  fromAgentId?: string,
) {
  return client.request(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      text,
      clientMessageId: crypto.randomUUID(),
      ...(fromAgentId ? { fromAgentId } : {}),
    }),
  });
}
