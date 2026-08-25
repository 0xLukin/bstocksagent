import type { TermixClient } from "./client.js";

export async function sendConversationOffer(
  client: TermixClient,
  conversationId: string,
  body: {
    providerAgentId: string;
    price: string;
    currency: "USDT" | "USDC";
    deliveryDays: number;
    scope: string;
    proofMethod?: string;
    settlementType?: string;
    message?: string;
    validUntilHours?: number;
  },
) {
  return client.request(`/api/v1/conversations/${conversationId}/offers`, {
    method: "POST",
    body: JSON.stringify({
      proofMethod: "manual",
      settlementType: "escrow",
      validUntilHours: 72,
      ...body,
    }),
  });
}
