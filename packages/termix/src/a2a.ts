import type { TermixClient } from "./client.js";
import { getConversation, sendConversationMessage } from "./conversations.js";
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

function lastSeq(convo: Record<string, unknown>): number {
  const last = convo.lastMessage as { seq?: unknown } | undefined;
  return typeof last?.seq === "number" ? last.seq : 0;
}

/**
 * A2A runtime/reply can persist a row without moving conversation.lastMessage
 * (seen after SETTLED). The inbox UI is watermarked on lastMessage, so the
 * buyer never sees that row. Fall back to the session message API.
 */
export async function ensureConversationReply(
  client: TermixClient,
  conversationId: string,
  text: string,
  fromAgentId?: string,
): Promise<"a2a" | "session"> {
  let before = 0;
  try {
    before = lastSeq(await getConversation(client, conversationId));
  } catch {
    /* still try A2A */
  }
  await replyA2A(client, conversationId, text);
  if (!fromAgentId) return "a2a";
  try {
    const after = lastSeq(await getConversation(client, conversationId));
    if (after > before) return "a2a";
  } catch {
    /* fall through */
  }
  await sendConversationMessage(client, conversationId, text, fromAgentId);
  return "session";
}
