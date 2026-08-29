import { issueRuntimeToken, pollInbox, replyA2A, signalThinking, walletLogin, type InboxMessage, TermixClient } from "@bstocks/termix";
import { getA2AStatus, noteA2A } from "./a2aStatus.js";
import type { ConversationStore } from "./conversation.js";
import { acceptFundedOrder, hireEventReply, isSystemHireEvent, refreshHireFromTermix } from "./hire.js";
import { loadInboxSince, saveInboxSince } from "./inboxCursor.js";
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
  const ensureAuth = async () => {
    await walletLogin(client);
    await issueRuntimeToken(client, opts.agentId);
    noteA2A({ tokenIssued: true, polling: true, lastError: undefined });
  };

  for (let i = 0; i < 6; i++) {
    try {
      await ensureAuth();
      break;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      noteA2A({ tokenIssued: false, polling: false, lastError: text });
      console.error("[a2a] login/token failed:", text);
      if (i === 5) {
        setInterval(() => {
          void ensureAuth().catch((e) => {
            noteA2A({ lastError: e instanceof Error ? e.message : String(e) });
          });
        }, 30_000);
      } else {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  if (getA2AStatus().tokenIssued) {
    console.log(`[a2a] runtime token issued for ${opts.agentId}; polling every ${opts.pollMs}ms`);
  } else {
    console.warn(`[a2a] token not issued yet — retrying login; HTTP /health stays up`);
  }

  let since = loadInboxSince(opts.dataDir);

  const tick = async () => {
    try {
      const inbox = await pollInbox(client, since);
      for (const msg of inbox) {
        await handleMessage(msg, client, opts);
        if (msg.createdAt > since) since = msg.createdAt;
      }
      saveInboxSince(opts.dataDir, since);
      noteA2A({
        lastPollAt: new Date().toISOString(),
        lastInboxAt: since,
        lastError: undefined,
        polling: true,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      noteA2A({ lastError: text, lastPollAt: new Date().toISOString() });
      if (text.includes("401")) {
        try {
          await ensureAuth();
        } catch (e) {
          const re = e instanceof Error ? e.message : String(e);
          noteA2A({ lastError: re, tokenIssued: false });
          console.error("[a2a] reauth failed", re);
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
  if (opts.conversations.alreadySeen(msg.conversationId, msg.messageId)) return;
  const ingested = opts.conversations.ingestTermixMessage(msg);
  if (ingested.duplicate) return;
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
  await refreshHireFromTermix(ctx);
  if (ctx.conversation.hirePhase === "funded" && ctx.conversation.lastOrderId) {
    try {
      await acceptFundedOrder(ctx, ctx.conversation.lastOrderId);
    } catch (err) {
      console.error("[a2a] provider-accept failed", err instanceof Error ? err.message : err);
    }
  }
  const text = msg.text ?? "";
  if (isSystemHireEvent(text, msg.orderId, msg.kind)) {
    const reply = hireEventReply(ctx.conversation);
    opts.conversations.appendTurn(msg.conversationId, "user", text || `[${msg.kind ?? "event"}]`, msg.messageId);
    opts.conversations.appendTurn(msg.conversationId, "assistant", reply);
    await replyA2A(termix, msg.conversationId, reply);
    return;
  }
  const reply = await runAgentTurn(text, ctx, opts.llm);
  await replyA2A(termix, msg.conversationId, reply);
}
