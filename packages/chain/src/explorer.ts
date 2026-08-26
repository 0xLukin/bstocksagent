import { getAddress, type Address } from "viem";

export const PANCAKE_EXPLORER_LIST = "https://explorer.pancakeswap.com/api/cached/pools/list";

export type ExplorerToken = {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
};

export type ExplorerPoolRow = {
  id: string;
  chainId: number;
  protocol: string;
  feeTier: number;
  tvlUSD: string | number;
  volumeUSD24h?: string | number;
  apr24h?: string | number;
  token0: ExplorerToken;
  token1: ExplorerToken;
};

type ExplorerListResponse = {
  rows?: ExplorerPoolRow[];
  hasNextPage?: boolean;
};

/**
 * Same backend as pancakeswap.finance/liquidity/pools.
 * `search=` is ignored by this API — filter by `tokens=56:0x…`.
 */
export async function fetchExplorerV3PoolsForToken(
  token: Address,
  fetchImpl: typeof fetch = fetch,
): Promise<ExplorerPoolRow[]> {
  const url = new URL(PANCAKE_EXPLORER_LIST);
  url.searchParams.set("chains", "bsc");
  url.searchParams.set("protocols", "v3");
  url.searchParams.set("orderBy", "tvlUSD");
  url.searchParams.set("tokens", `56:${getAddress(token)}`);
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Pancake Explorer ${res.status}`);
  }
  const json = (await res.json()) as ExplorerListResponse;
  return json.rows ?? [];
}
