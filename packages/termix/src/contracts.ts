import type { TermixClient } from "./client.js";
import type { TermixContracts } from "./types.js";

/** Live Termix addresses. Never hardcode — always fetch. */
export async function fetchContracts(client: TermixClient): Promise<TermixContracts> {
  return client.request<TermixContracts>(`/api/v1/config/contracts`, { auth: "none" });
}

export function currencyContracts(cfg: TermixContracts, symbol: "USDT" | "USDC") {
  const row = cfg.settlementCurrencies.find((c) => c.symbol.toUpperCase() === symbol);
  if (!row) throw new Error(`Settlement currency ${symbol} not in live Termix config`);
  return row;
}
