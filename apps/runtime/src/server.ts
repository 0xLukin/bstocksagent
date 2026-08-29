import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress } from "viem";
import type { Hex } from "viem";
import type { ConversationStore } from "./conversation.js";
import { assertIntentBinding, type IntentStore } from "./intents.js";
import { getA2AStatus } from "./a2aStatus.js";
import { serviceFeeLabel } from "./hire.js";
import { runAgentTurn } from "./llm.js";

export function createApp(
  intents: IntentStore,
  extras?: {
    conversations?: ConversationStore;
    signerWebUrl?: string;
    dataDir?: string;
    llm?: { llmBase: string; llmKey: string; llmModel: string };
  },
) {
  const app = new Hono();
  app.use("*", cors({ origin: "*" }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      chainId: 56,
      serviceFee: serviceFeeLabel(),
      a2a: getA2AStatus(),
    }),
  );

  app.post("/chat", async (c) => {
    if (!extras?.conversations || !extras.llm) {
      return c.json({ error: "chat_disabled" }, 503);
    }
    const body = (await c.req.json()) as {
      conversationId?: string;
      text?: string;
      source?: "termix" | "local";
    };
    const conversationId = body.conversationId ?? "local";
    const text = body.text ?? "";
    extras.conversations.ingestUserText(conversationId, text);
    if (body.source === "termix") {
      const s = extras.conversations.get(conversationId);
      s.source = "termix";
      if (!s.hirePhase || s.hirePhase === "none") s.hirePhase = s.geoConfirmed ? "quoting" : "none";
      extras.conversations.save(s);
    }
    const reply = await runAgentTurn(text, {
      conversation: extras.conversations.get(conversationId),
      conversations: extras.conversations,
      intents,
      signerWebUrl: extras.signerWebUrl ?? "http://127.0.0.1:3000",
      dataDir: extras.dataDir ?? ".data",
    }, extras.llm);
    return c.json({ reply, state: extras.conversations.get(conversationId) });
  });

  app.get("/intents/:id", (c) => {
    const intent = intents.get(c.req.param("id"));
    if (!intent) return c.json({ error: "not_found" }, 404);
    return c.json(intent);
  });

  app.post("/intents/:id/tx", async (c) => {
    const body = (await c.req.json()) as { txHash?: string; address?: string };
    if (!body.txHash || !body.address) {
      return c.json({ error: "txHash and address required" }, 400);
    }
    try {
      const intent = intents.recordTx(c.req.param("id"), body.txHash as Hex, getAddress(body.address));
      return c.json({ ok: true, intent });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/intents/:id/cancel", async (c) => {
    try {
      const intent = intents.cancel(c.req.param("id"));
      if (intent.conversationId && extras?.conversations) {
        extras.conversations.cancelPending(intent.conversationId);
      }
      return c.json({ ok: true, intent });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const status = text.includes("Already broadcast") ? 409 : text.includes("not found") ? 404 : 400;
      return c.json({ error: text }, status);
    }
  });

  app.post("/intents/:id/bind-check", async (c) => {
    const body = (await c.req.json()) as { address?: string };
    const intent = intents.get(c.req.param("id"));
    if (!intent) return c.json({ error: "not_found" }, 404);
    try {
      assertIntentBinding(intent, body.address ?? "");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}

export function listen(app: Hono, port: number) {
  return serve({ fetch: app.fetch, port });
}
