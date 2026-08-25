/**
 * Creates and optionally publishes the single MVP listing.
 * Default is dry-run (prints payload). Pass --publish to actually create+publish.
 */
import { loadRepoEnv } from "@bstocks/chain";
import { createListing, LISTING_DRAFT, publishListing, TermixClient, walletLogin } from "@bstocks/termix";

loadRepoEnv();

async function main() {
  const doPublish = process.argv.includes("--publish");
  const agentId = process.env.TERMIX_AGENT_ID;
  console.log("Listing draft (instantBuyable=false, deliveryDays=3, USDT):\n", JSON.stringify(LISTING_DRAFT, null, 2));
  if (!doPublish) {
    console.log("Dry run. Re-run with --publish after TERMIX_AGENT_ID + WALLET_KEY are set.");
    return;
  }
  if (!agentId || !process.env.WALLET_KEY) {
    throw new Error("TERMIX_AGENT_ID and WALLET_KEY required for --publish");
  }
  const client = new TermixClient();
  await walletLogin(client);
  const created = await createListing(client, agentId);
  console.log("created", created);
  const pub = await publishListing(client, created.id);
  console.log("published", pub);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
