import { loadRepoEnv } from "@bstocks/chain";
import { broadcastIntent, getOnchainTx, prepareProviderAccept, TermixClient, walletLogin } from "@bstocks/termix";

loadRepoEnv();

async function main() {
  const orderId = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[1]) ?? process.argv[2];
  const dry = !process.argv.includes("--broadcast");
  if (!orderId || orderId.includes("provider-accept")) {
    console.log("Usage: pnpm termix:accept -- <orderId> [--broadcast]");
    return;
  }
  if (!process.env.WALLET_KEY) {
    console.log("WALLET_KEY missing — cannot accept. This is the Termix escrow side (agent wallet).");
    return;
  }
  const client = new TermixClient();
  await walletLogin(client);
  const intent = await prepareProviderAccept(client, orderId);
  console.log("accept intent", { action: intent.action, chainId: intent.chainId, to: intent.to ?? intent.contract });
  if (dry) {
    console.log("Dry run. Pass --broadcast to send.");
    return;
  }
  const hash = await broadcastIntent(intent);
  console.log("tx", hash);
  console.log("indexer", await getOnchainTx(client, hash));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
