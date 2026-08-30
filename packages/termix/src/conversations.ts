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

export async function listConversationMessages(
  client: TermixClient,
  conversationId: string,
  opts?: { afterSeq?: number },
) {
  const q = opts?.afterSeq != null ? `?afterSeq=${opts.afterSeq}` : "";
  return client.request<{ items?: Array<Record<string, unknown>> }>(
    `/api/v1/conversations/${conversationId}/messages${q}`,
  );
}

function messageSeq(row: unknown): number {
  return row && typeof row === "object" && typeof (row as { seq?: unknown }).seq === "number"
    ? (row as { seq: number }).seq
    : 0;
}

/** Termix /messages defaults to the oldest 50 rows. lastMessage.seq is the tail. */
export async function conversationTailSeq(client: TermixClient, conversationId: string): Promise<number> {
  const convo = await getConversation(client, conversationId);
  const last = messageSeq(convo.lastMessage);
  if (last) return last;
  const embedded = Array.isArray(convo.messages) ? convo.messages : [];
  const fromEmbed = embedded.reduce((max, row) => Math.max(max, messageSeq(row)), 0);
  if (fromEmbed) return fromEmbed;
  const page = await listConversationMessages(client, conversationId);
  return (page.items ?? []).reduce((max, row) => Math.max(max, messageSeq(row)), 0);
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
