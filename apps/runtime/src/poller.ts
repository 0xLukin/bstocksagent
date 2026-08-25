import { issueRuntimeToken, pollInbox, replyA2A, signalThinking, walletLogin, type InboxMessage, TermixClient } from "@bstocks/termix";
import type { ConversationStore } from "./conversation.js";
import { runAgentTurn } from "./llm.js";
import type { ToolCtx } from "./tools.js";
import type { IntentStore } from "./intents.js";

export async function startA2APoller(opts: {
  conversations: ConversationStore;
  intents: IntentStore;
  signerWebUrl: string;
  dataDir: string;
  agentId: string;
  pollMs: number;
  llm: { llmBase: string; llmKey: string; llmModel: string };
}) {
  if (!opts.agentId) {
    console.warn("[a2a] TERMIX_AGENT_ID unset — inbox poller idle (local signer/CLI still work).");
    return;
  }
  if (!process.env.WALLET_KEY) {
    console.warn("[a2a] WALLET_KEY unset — cannot login. Poller idle.");
    return;
  }

  const client = new TermixClient();
  await walletLogin(client);
  await issueRuntimeToken(client, opts.agentId);
  console.log(`[a2a] runtime token issued for ${opts.agentId}; polling every ${opts.pollMs}ms`);

  let since = new Date(Date.now() - 60_000).toISOString();
  const seen = new Set<string>();

  const tick = async () => {
    try {
      const inbox = await pollInbox(client, since);
      for (const msg of inbox) {
        await handleMessage(msg, client, opts);
        seen.add(msg.messageId);
        if (msg.createdAt > since) since = msg.createdAt;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (text.includes("401")) {
        try {
          await walletLogin(client);
          await issueRuntimeToken(client, opts.agentId);
        } catch (e) {
          console.error("[a2a] reauth failed", e);
        }
      } else {
        console.error("[a2a] poll error", text);
      }
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, opts.pollMs);
}

async function handleMessage(
  msg: InboxMessage,
  termix: TermixClient,
  opts: {
    conversations: ConversationStore;
    intents: IntentStore;
    signerWebUrl: string;
    dataDir: string;
    agentId: string;
    llm: { llmBase: string; llmKey: string; llmModel: string };
  },
) {
  const state = opts.conversations.ingestUserText(msg.conversationId, msg.text ?? "");
  if (msg.orderId) {
    state.lastOrderId = msg.orderId;
    opts.conversations.save(state);
  }
  void signalThinking(termix, msg.conversationId);
  const ctx: ToolCtx = {
    conversation: opts.conversations.get(msg.conversationId),
    conversations: opts.conversations,
    intents: opts.intents,
    signerWebUrl: opts.signerWebUrl,
    termix,
    agentId: opts.agentId,
    dataDir: opts.dataDir,
  };
  const reply = await runAgentTurn(msg.text ?? "", ctx, opts.llm);
  await replyA2A(termix, msg.conversationId, reply);
}
