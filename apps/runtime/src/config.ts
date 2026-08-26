import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findRepoRoot } from "@bstocks/chain";

export type LlmProvider = "deepseek" | "openrouter" | "openai" | "none";

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env) {
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim() ?? "";
  const openrouterKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  const openaiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const explicitBase = env.OPENAI_BASE_URL?.trim();
  const explicitModel = env.A2A_LLM_MODEL?.trim();

  if (deepseekKey) {
    const baseLooksDeepseek = !explicitBase || explicitBase.includes("deepseek.com");
    const modelLooksDeepseek = !explicitModel || explicitModel.startsWith("deepseek");
    return {
      provider: "deepseek" as const,
      llmKey: deepseekKey,
      llmBase: baseLooksDeepseek ? (explicitBase || "https://api.deepseek.com") : "https://api.deepseek.com",
      llmModel: modelLooksDeepseek ? (explicitModel || "deepseek-v4-flash") : "deepseek-v4-flash",
    };
  }
  if (openrouterKey || openaiKey) {
    return {
      provider: (openrouterKey ? "openrouter" : "openai") as LlmProvider,
      llmKey: openrouterKey || openaiKey,
      llmBase: explicitBase || "https://openrouter.ai/api/v1",
      llmModel: explicitModel || "openai/gpt-4o-mini",
    };
  }
  return {
    provider: "none" as const,
    llmKey: "",
    llmBase: "https://api.deepseek.com",
    llmModel: explicitModel || "deepseek-v4-flash",
  };
}

export function loadEnv() {
  const root = findRepoRoot();
  const llm = resolveLlmConfig();
  return {
    root,
    dataDir: resolveDataDir(root, process.env.DATA_DIR),
    port: Number(process.env.RUNTIME_PORT ?? "8787"),
    publicUrl: process.env.RUNTIME_PUBLIC_URL ?? "http://127.0.0.1:8787",
    signerWebUrl: process.env.SIGNER_WEB_URL ?? "http://127.0.0.1:3000",
    pollMs: Math.max(5000, Number(process.env.A2A_POLL_INTERVAL_MS ?? "5000")),
    intentTtlMs: Number(process.env.INTENT_TTL_MS ?? "180000"),
    agentId: process.env.TERMIX_AGENT_ID ?? "",
    agentHandle: process.env.TERMIX_AGENT_HANDLE ?? "bstocks-yield",
    ...llm,
  };
}

export function resolveDataDir(root: string, raw?: string) {
  if (!raw) return join(root, ".data");
  return isAbsolute(raw) ? raw : join(root, raw);
}

export function ensureDataDir(dir: string) {
  mkdirSync(join(dir, "intents"), { recursive: true });
  mkdirSync(join(dir, "conversations"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
}
