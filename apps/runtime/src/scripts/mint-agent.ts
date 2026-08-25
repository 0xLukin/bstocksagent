/**
 * Dry-run safe: prepares a Termix agent mint for handle bstocks-yield.
 * Does NOT broadcast unless --broadcast is passed AND WALLET_KEY is set.
 */
import { loadRepoEnv } from "@bstocks/chain";
import { agentByTx, broadcastIntent, fetchContracts, nameAvailability, prepareMint, TermixClient, walletLogin } from "@bstocks/termix";

loadRepoEnv();

const HANDLE = process.env.TERMIX_AGENT_HANDLE ?? "bstocks-yield";

async function main() {
  const broadcast = process.argv.includes("--broadcast");
  const client = new TermixClient();
  const contracts = await fetchContracts(client);
  console.log("Live Termix chainId", contracts.chainId, "identity", contracts.contracts.identityRegistry?.address);

  const avail = await nameAvailability(client, HANDLE);
  console.log("name-availability", avail);
  if (!avail.available) {
    console.log("Handle taken. Do not mint again. Set TERMIX_AGENT_ID to the existing agent.");
    return;
  }

  if (!process.env.WALLET_KEY) {
    console.log("WALLET_KEY missing — stopping before prepare. Fill .env then re-run.");
    console.log("When ready: pnpm termix:mint -- --broadcast");
    return;
  }

  await walletLogin(client);
  const prepared = await prepareMint(client, {
    name: HANDLE,
    displayName: "bStocks Yield",
    category: "Automation & Ops",
    description:
      "非托管 bStocks 交易与 PancakeSwap V3 LP 助手。用户自行签名；不构成投资建议；美国及受限地区不可用。",
    tags: ["bstocks", "pancakeswap", "automation"],
  });
  console.log("Prepared mint (not yet sent):", {
    contract: prepared.contract,
    tokenUri: prepared.tokenUri,
    callDataBytes: prepared.callData.length,
  });

  if (!broadcast) {
    console.log("Dry run only. Re-run with --broadcast to send the mint tx from WALLET_KEY.");
    return;
  }

  const hash = await broadcastIntent({
    chainId: 56,
    contract: prepared.contract,
    callData: prepared.callData,
    value: "0",
  });
  console.log("Broadcast", hash);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await agentByTx(client, hash);
    console.log("indexer", st.status, st.agent?.id);
    if (st.status === "CONFIRMED" && st.agent?.id) {
      console.log("Set TERMIX_AGENT_ID=" + st.agent.id);
      return;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
