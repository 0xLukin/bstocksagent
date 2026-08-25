import { join } from "node:path";
import { getPublicClient, loadRepoEnv } from "@bstocks/chain";
loadRepoEnv();
import { fetchContracts, TermixClient } from "@bstocks/termix";
import { ensureDataDir, loadEnv } from "./config.js";
import { ConversationStore } from "./conversation.js";
import { IntentStore } from "./intents.js";
import { startA2APoller } from "./poller.js";
import { createApp, listen } from "./server.js";
import { startOrderWatchdog } from "./watchdog.js";

async function main() {
  const env = loadEnv();
  ensureDataDir(env.dataDir);
  const intents = new IntentStore(join(env.dataDir, "intents"), env.intentTtlMs);
  const conversations = new ConversationStore(join(env.dataDir, "conversations"));

  try {
    const chainId = await getPublicClient().getChainId();
    if (chainId !== 56) throw new Error(`RPC chainId ${chainId} is not BSC`);
    console.log("[runtime] BSC RPC ok");
  } catch (err) {
    console.warn("[runtime] BSC RPC check failed:", err instanceof Error ? err.message : err);
  }

  try {
    const contracts = await fetchContracts(new TermixClient());
    console.log("[runtime] Termix contracts fetched", {
      chainId: contracts.chainId,
      currencies: contracts.settlementCurrencies.map((c) => c.symbol),
    });
  } catch (err) {
    console.warn("[runtime] Termix config fetch failed:", err instanceof Error ? err.message : err);
  }

  const app = createApp(intents, {
    conversations,
    signerWebUrl: env.signerWebUrl,
    dataDir: env.dataDir,
    llm: { llmBase: env.llmBase, llmKey: env.llmKey, llmModel: env.llmModel },
  });
  listen(app, env.port);
  console.log(`[runtime] intent HTTP on :${env.port}  (POST /chat for local)`);
  console.log(
    env.llmKey
      ? `[runtime] LLM ${env.provider} model=${env.llmModel} base=${env.llmBase}`
      : "[runtime] LLM unset — rule fallback (set DEEPSEEK_API_KEY)",
  );

  await startA2APoller({
    conversations,
    intents,
    signerWebUrl: env.signerWebUrl,
    dataDir: env.dataDir,
    agentId: env.agentId,
    pollMs: env.pollMs,
    llm: { llmBase: env.llmBase, llmKey: env.llmKey, llmModel: env.llmModel },
  });
  startOrderWatchdog();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
