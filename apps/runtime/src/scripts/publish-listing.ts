/**
 * Creates and optionally publishes the single MVP listing.
 * Default is dry-run (prints payload). Pass --publish to actually create+publish.
 */
import { loadRepoEnv } from "@bstocks/chain";
import {
  createListing,
  listingDraft,
  publishListing,
  TermixClient,
  updateListing,
  walletLogin,
} from "@bstocks/termix";

loadRepoEnv();

async function main() {
  const doPublish = process.argv.includes("--publish");
  const doUpdate = process.argv.includes("--update");
  const agentId = process.env.TERMIX_AGENT_ID;
  const listingId = process.env.TERMIX_LISTING_ID ?? "cmtdjaletb3yftg012bh5xma2";
  const draft = listingDraft();
  console.log("Listing draft (instantBuyable=false, one 0.01 USDC package):\n", JSON.stringify(draft, null, 2));
  if (!doPublish && !doUpdate) {
    console.log("Dry run. Re-run with --update to PATCH the live listing, or --publish to create a new one.");
    return;
  }
  if (!agentId || !process.env.WALLET_KEY) {
    throw new Error("TERMIX_AGENT_ID and WALLET_KEY required to write the listing");
  }
  const client = new TermixClient();
  await walletLogin(client);
  if (doUpdate) {
    const updated = await updateListing(client, listingId, {
      title: draft.title,
      description: draft.description,
      packages: draft.packages,
    });
    console.log("updated", listingId, updated);
    return;
  }
  const created = await createListing(client, agentId, draft);
  console.log("created", created);
  const pub = await publishListing(client, created.id);
  console.log("published", pub);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
