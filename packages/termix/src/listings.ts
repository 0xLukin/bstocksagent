import type { TermixClient } from "./client.js";

export const LISTING_DRAFT = {
  title: "bStocks 交易 + PancakeSwap V3 加 LP（一次性）",
  category: "Automation & Ops",
  basePrice: process.env.LISTING_BASE_PRICE ?? "99",
  currency: "USDT" as const,
  deliveryDays: Number(process.env.LISTING_DELIVERY_DAYS ?? "3"),
  description: [
    "一次性服务：协助在 BNB Chain 上交易白名单 bStocks，并在 PancakeSwap V3 加/管理 LP。",
    "非托管：用户用自己的钱包在签名页确认并广播交易，Agent 不持有用户私钥。",
    "交付物：Markdown/JSON 报告、全部 txHash、签名页操作记录、风险声明。",
    "合规：不构成投资建议；美国及受限地区不可用；bStocks 为证书类敞口，非直接持股。",
  ].join("\n"),
  skillTag: "bstocks-pancake-v3",
  tags: ["bstocks", "pancakeswap", "lp", "bnb-chain"],
  instantBuyable: false,
  publicSearch: true,
  proofMethod: "manual",
  settlementType: "escrow",
};

export async function createListing(client: TermixClient, agentId: string, draft = LISTING_DRAFT) {
  return client.request<{ id: string; status: string }>(`/api/v1/agents/${agentId}/services`, {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export async function publishListing(client: TermixClient, listingId: string) {
  return client.request(`/api/v1/listings/${listingId}/publish`, { method: "POST" });
}
