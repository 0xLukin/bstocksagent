import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@bstocks/chain";

export function loadEnv() {
  const root = findRepoRoot();
  return {
    root,
    dataDir: process.env.DATA_DIR ?? join(root, ".data"),
    port: Number(process.env.RUNTIME_PORT ?? "8787"),
    publicUrl: process.env.RUNTIME_PUBLIC_URL ?? "http://127.0.0.1:8787",
    signerWebUrl: process.env.SIGNER_WEB_URL ?? "http://127.0.0.1:3000",
    pollMs: Math.max(5000, Number(process.env.A2A_POLL_INTERVAL_MS ?? "5000")),
    intentTtlMs: Number(process.env.INTENT_TTL_MS ?? "1800000"),
    agentId: process.env.TERMIX_AGENT_ID ?? "",
    agentHandle: process.env.TERMIX_AGENT_HANDLE ?? "bstocks-yield",
    llmModel: process.env.A2A_LLM_MODEL ?? "openai/gpt-4o-mini",
    llmBase: process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1",
    llmKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "",
  };
}

export function ensureDataDir(dir: string) {
  mkdirSync(join(dir, "intents"), { recursive: true });
  mkdirSync(join(dir, "conversations"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
}
