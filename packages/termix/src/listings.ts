import type { TermixClient } from "./client.js";

const LISTING_TITLE = "Guided bStocks trades and PancakeSwap V3 LP on BNB Chain";

const LISTING_DESCRIPTION = [
  "Non-custodial execution on BNB Chain: whitelist bStocks swaps and PancakeSwap V3 LP, then a written report. You keep your keys. Nothing moves until you sign.",
  "",
  "The 0.01 USDC fee is Termix escrow for the session and report — not a stock purchase. Your USDT, USDC, or BNB only move from your wallet on the signer page.",
  "",
  "Flow: geo check → accept the 0.01 USDC card and checkout → quote a whitelist size → confirm and sign → deliver. Pancake V3 only (NVDAB, MSFTB, and other listed names). Not investment advice; no yield promised. Unavailable in the United States and restricted regions. Delivery 3 days; 48-hour challenge window.",
  "",
  "What to type",
  "I confirm I am not in the United States or a restricted region",
  "send the standard offer",
  "buy 10 USDT of NVDAB",
  "confirm",
  "deliver now",
  "confirm empty delivery",
  "another hire",
  "cancel",
].join("\n");

const LISTING_PACKAGE_SCOPE =
  "One guided whitelist bStocks swap or Pancake V3 LP action on BNB Chain, plus a written report. You sign from your own wallet. 0.01 USDC escrow fee. Not investment advice.";

export function listingDraft() {
  const basePrice = process.env.LISTING_BASE_PRICE ?? "0.01";
  const deliveryDays = Number(process.env.LISTING_DELIVERY_DAYS ?? "3");
  return {
    title: LISTING_TITLE,
    category: "Automation & Ops",
    basePrice,
    currency: (process.env.LISTING_CURRENCY ?? "USDC") as "USDC" | "USDT",
    deliveryDays,
    description: LISTING_DESCRIPTION,
    skillTag: "bstocks-pancake-v3",
    tags: ["bstocks", "pancakeswap", "lp", "bnb-chain"],
    instantBuyable: false,
    publicSearch: true,
    proofMethod: "manual",
    settlementType: "escrow",
    packages: [
      {
        id: "standard",
        name: "Standard",
        price: basePrice,
        scope: LISTING_PACKAGE_SCOPE,
        delivery: String(deliveryDays),
      },
    ],
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

export async function updateListing(
  client: TermixClient,
  listingId: string,
  body: Record<string, unknown>,
) {
  return client.request(`/api/v1/listings/${listingId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function publishListing(client: TermixClient, listingId: string) {
  return client.request(`/api/v1/listings/${listingId}/publish`, { method: "POST" });
}

export async function getListing(client: TermixClient, listingId: string) {
  return client.request<Record<string, unknown>>(`/api/v1/listings/${listingId}`, { auth: "none" });
}
