import type { TermixClient } from "./client.js";
import type { InboxMessage } from "./types.js";

export async function pollInbox(
  client: TermixClient,
  since: string,
  limit = 50,
): Promise<InboxMessage[]> {
  const q = new URLSearchParams({ since, limit: String(limit) });
  const res = await client.request<InboxMessage[] | { items?: InboxMessage[] }>(
    `/api/v1/a2a/runtime/inbox?${q}`,
    { auth: "runtime" },
  );
  return Array.isArray(res) ? res : (res.items ?? []);
}

export async function signalThinking(client: TermixClient, conversationId: string): Promise<void> {
  try {
    await client.request(`/api/v1/a2a/runtime/signal`, {
      method: "POST",
      auth: "runtime",
      body: JSON.stringify({ conversationId, state: "thinking" }),
    });
  } catch {
    // Signals are best-effort.
  }
}

export async function replyA2A(client: TermixClient, conversationId: string, text: string): Promise<void> {
  await client.request(`/api/v1/a2a/runtime/reply`, {
    method: "POST",
    auth: "runtime",
    body: JSON.stringify({ conversationId, text }),
  });
}
