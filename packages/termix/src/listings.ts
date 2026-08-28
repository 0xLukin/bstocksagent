import type { TermixClient } from "./client.js";

/** Marketplace floor on live Termix is 0.5 (display units). Docs do not publish a smaller official min. */
export function listingDraft() {
  return {
    title: "One-time bStocks trading + PancakeSwap V3 LP",
    category: "Automation & Ops",
    basePrice: process.env.LISTING_BASE_PRICE ?? "0.5",
    currency: (process.env.LISTING_CURRENCY ?? "USDC") as "USDC" | "USDT",
    deliveryDays: Number(process.env.LISTING_DELIVERY_DAYS ?? "3"),
    description: [
      "One-time help trading whitelist bStocks on BNB Chain and adding/managing PancakeSwap V3 LP.",
      "Non-custodial: you confirm and broadcast from your own wallet on the signer page. The agent never holds your private key.",
      "Deliverable: Markdown/JSON report, all tx hashes, signer-page log, and risk disclosures.",
      "Not investment advice. Unavailable in the United States and restricted regions. bStocks are certificate-style exposure, not the underlying stock.",
    ].join("\n"),
    skillTag: "bstocks-pancake-v3",
    tags: ["bstocks", "pancakeswap", "lp", "bnb-chain"],
    instantBuyable: false,
    publicSearch: true,
    proofMethod: "manual",
    settlementType: "escrow",
  };
}

export async function createListing(
  client: TermixClient,
  agentId: string,
  draft = listingDraft(),
) {
  return client.request<{ id: string; status: string }>(`/api/v1/agents/${agentId}/services`, {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function publishListing(client: TermixClient, listingId: string) {
  return client.request(`/api/v1/listings/${listingId}/publish`, { method: "POST" });
}
