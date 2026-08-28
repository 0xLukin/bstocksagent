import { getAddress, type Address } from "viem";
import { fetchExplorerV3PoolsForToken, type ExplorerPoolRow } from "./explorer.js";
import { getToken, isWhitelisted } from "./registry.js";
import type { TokenRecord } from "./types.js";

/** Below this, APR is shown but not used as “highest” or mint target. */
export const LP_APR_MIN_TVL_USD = 10_000;
export const LP_APR_MIN_VOLUME_USD = 1_000;

export type ComparedLpPool = {
  token: string;
  quote: string;
  fee: number;
  feeLabel: string;
  pool: Address;
  tvlUsd: number;
  volumeUsd24h: number;
  apr24hPct: number;
  thin: boolean;
};

export type CompareLpResult = {
  kind: "lp-compare";
  token: string;
  pools: ComparedLpPool[];
  ranked: ComparedLpPool[];
  highestApr?: ComparedLpPool;
  thickest?: ComparedLpPool;
  disclaimer: string;
};

export function feeTierLabel(fee: number): string {
  const pct = fee / 10_000;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

function num(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function quoteSide(queried: TokenRecord, t0: TokenRecord, t1: TokenRecord): TokenRecord | undefined {
  const q = t0.address.toLowerCase() === queried.address.toLowerCase() ? t1 : t0;
  if (q.kind !== "stable" && q.kind !== "gas") return undefined;
  return q;
}

export function rankWhitelistV3Pools(token: string, rows: ExplorerPoolRow[]): CompareLpResult {
  const queried = getToken(token);
  const seen = new Set<string>();
  const pools: ComparedLpPool[] = [];

  for (const row of rows) {
    if (row.chainId !== 56 || row.protocol !== "v3") continue;
    if (!row.token0?.id || !row.token1?.id) continue;
    if (!isWhitelisted(row.token0.id) || !isWhitelisted(row.token1.id)) continue;
    const t0 = getToken(row.token0.id);
    const t1 = getToken(row.token1.id);
    const pair = new Set([t0.address.toLowerCase(), t1.address.toLowerCase()]);
    if (!pair.has(queried.address.toLowerCase())) continue;
    const quote = quoteSide(queried, t0, t1);
    if (!quote) continue;
    let pool: Address;
    try {
      pool = getAddress(row.id);
    } catch {
      continue;
    }
    const key = `${quote.symbol}:${row.feeTier}:${pool.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tvlUsd = num(row.tvlUSD);
    const volumeUsd24h = num(row.volumeUSD24h);
    const thin = tvlUsd < LP_APR_MIN_TVL_USD || volumeUsd24h < LP_APR_MIN_VOLUME_USD;
    pools.push({
      token: queried.symbol,
      quote: quote.symbol,
      fee: row.feeTier,
      feeLabel: feeTierLabel(row.feeTier),
      pool,
      tvlUsd,
      volumeUsd24h,
      apr24hPct: num(row.apr24h) * 100,
      thin,
    });
  }

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const ranked = pools.filter((p) => !p.thin).sort((a, b) => b.apr24hPct - a.apr24hPct);
  const highestApr = ranked[0];
  const thickest = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];

  return {
    kind: "lp-compare",
    token: queried.symbol,
    pools,
    ranked,
    highestApr,
    thickest,
    disclaimer:
      "apr24h is Pancake Explorer 24h fee APR, not a yield promise and not your ranged-position return. Thin-pool numbers are not usable. Whitelist V3 only (quote assets USDT/USDC/WBNB).",
  };
}

export function pickComparedPool(
  result: CompareLpResult,
  sel: { pick?: "highest" | "thickest"; quote?: string; fee?: number },
): ComparedLpPool | undefined {
  const quote = sel.quote ? getToken(sel.quote).symbol : undefined;
  const match = (p: ComparedLpPool) =>
    (!quote || p.quote === quote) && (sel.fee == null || p.fee === sel.fee);

  if (quote && sel.fee != null) {
    return result.pools.find((p) => p.quote === quote && p.fee === sel.fee);
  }
  if (sel.pick === "thickest") {
    return result.pools.filter((p) => !p.thin && match(p)).sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  }
  if (sel.pick === "highest" || (!quote && sel.fee == null)) {
    return result.ranked.find(match) ?? result.ranked[0];
  }
  return result.ranked.find(match) ?? result.pools.filter((p) => !p.thin && match(p))[0];
}

export async function compareLpPools(token: string): Promise<CompareLpResult> {
  const rec = getToken(token);
  const rows = await fetchExplorerV3PoolsForToken(rec.address);
  return rankWhitelistV3Pools(rec.symbol, rows);
}
