import { type Address, type PublicClient } from "viem";
import { erc20Abi, factoryAbi, poolAbi, quoterV2Abi } from "./abis.js";
import { ZERO_ADDRESS } from "./addresses.js";
import { getPublicClient } from "./client.js";
import {
  findConfiguredPool,
  getToken,
  loadPoolsFile,
  pancakeFromConfig,
  rawToUiDisplay,
  uiDisplayToRaw,
  wantsNativeBnb,
} from "./registry.js";
import { encodeV3Path } from "./ticks.js";
import type { SwapQuote, TokenRecord } from "./types.js";
import { markPairUsd, quotePerToken } from "./valuation.js";

/** Same default as config/risk.json minPoolLiquidityUsd. Thin pools can quote a hair more on tiny size. */
export const DEFAULT_MIN_QUOTE_TVL_USD = 5_000;

export type QuoteArgs = {
  tokenIn: string;
  tokenOut: string;
  amountInUi: string;
  fee?: number;
  /** Skip singles below this TVL unless the user pinned a fee. */
  minPoolTvlUsd?: number;
  client?: PublicClient;
};

export type QuoteCandidate = {
  amountOut: bigint;
  fee: number;
  pool?: Address;
  tvlUsd?: number;
  route: SwapQuote["route"];
  hops: SwapQuote["hops"];
  sqrtPriceX96After?: bigint;
};

function uniqueFees(fees: number[]): number[] {
  return fees.filter((v, i, a) => Number.isFinite(v) && v > 0 && a.indexOf(v) === i);
}

/** preferredFee first, then config feeTiers. An explicit fee is the only candidate. */
export function quoteFeeTiers(explicit?: number): number[] {
  if (explicit != null && explicit > 0) return [explicit];
  const cfg = loadPoolsFile();
  return uniqueFees([cfg.preferredFee, ...(cfg.feeTiers ?? [])]);
}

/** Intermediate tokens from quotePriority, skipping the pair itself. */
export function quoteBridges(tokenIn: TokenRecord, tokenOut: TokenRecord): TokenRecord[] {
  const seen = new Set<string>([tokenIn.address.toLowerCase(), tokenOut.address.toLowerCase()]);
  const out: TokenRecord[] = [];
  for (const sym of loadPoolsFile().quotePriority ?? []) {
    try {
      const mid = getToken(sym);
      if (seen.has(mid.address.toLowerCase())) continue;
      seen.add(mid.address.toLowerCase());
      out.push(mid);
    } catch {
      /* skip unknown config entries */
    }
  }
  return out;
}

export function hopFeeTiers(tokenA: TokenRecord, tokenB: TokenRecord): number[] {
  const configured = findConfiguredPool(tokenA.symbol, tokenB.symbol);
  const tiers = quoteFeeTiers();
  if (!configured) return tiers;
  return uniqueFees([configured.fee, ...tiers]);
}

export function richerQuote(a: QuoteCandidate | undefined, b: QuoteCandidate): QuoteCandidate {
  if (!a) return b;
  if (b.amountOut > a.amountOut) return b;
  if (b.amountOut === a.amountOut && b.hops.length < a.hops.length) return b;
  return a;
}

/** Prefer a pool that clears the TVL floor; only then maximize amountOut. */
export function pickBestQuote(candidates: QuoteCandidate[], minTvlUsd: number): QuoteCandidate | undefined {
  const thick = candidates.filter((c) => (c.tvlUsd ?? 0) >= minTvlUsd);
  if (thick.length) {
    let best: QuoteCandidate | undefined;
    for (const row of thick) best = richerQuote(best, row);
    return best;
  }
  const preferredFee = loadPoolsFile().preferredFee ?? 2500;
  const preferred = candidates.filter((c) => c.route === "v3-single" && c.fee === preferredFee);
  const pool = preferred.length ? preferred : candidates;
  let best: QuoteCandidate | undefined;
  for (const row of pool) best = richerQuote(best, row);
  return best;
}

async function resolvePool(
  client: PublicClient,
  tokenA: TokenRecord,
  tokenB: TokenRecord,
  fee: number,
): Promise<Address | undefined> {
  const configured = findConfiguredPool(tokenA.symbol, tokenB.symbol, fee);
  if (configured?.address) return configured.address;
  const factory = pancakeFromConfig().factory;
  const pool = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [tokenA.address, tokenB.address, fee],
  });
  if (pool.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
  return pool;
}

async function estimatePoolTvlUsd(client: PublicClient, pool: Address): Promise<number> {
  const state = await readPoolState(pool, client);
  const t0 = getToken(state.token0);
  const t1 = getToken(state.token1);
  const [bal0, bal1] = await Promise.all([
    client.readContract({ address: t0.address, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
    client.readContract({ address: t1.address, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
  ]);
  const amount0Ui = await rawToUiDisplay(client, t0, bal0);
  const amount1Ui = await rawToUiDisplay(client, t1, bal1);
  let usdPerGas: number | undefined;
  if (t0.kind === "gas" || t1.kind === "gas") {
    usdPerGas = await readUsdPerGasForQuote(client);
  }
  return markPairUsd({
    token0: t0,
    token1: t1,
    amount0Ui,
    amount1Ui,
    sqrtPriceX96: state.sqrtPriceX96,
    usdPerGas,
  });
}

async function readUsdPerGasForQuote(client: PublicClient): Promise<number> {
  const wbnb = getToken("WBNB");
  const usdt = getToken("USDT");
  for (const fee of [2500, 500, 10000, 100]) {
    const pool = await resolvePool(client, wbnb, usdt, fee);
    if (!pool) continue;
    try {
      const state = await readPoolState(pool, client);
      const mid = quotePerToken({
        token: wbnb,
        quote: usdt,
        token0: getToken(state.token0),
        token1: getToken(state.token1),
        sqrtPriceX96: state.sqrtPriceX96,
      });
      if (mid > 0) return mid;
    } catch {
      /* next fee */
    }
  }
  return 0;
}

async function quoteSingle(
  client: PublicClient,
  tokenIn: TokenRecord,
  tokenOut: TokenRecord,
  amountInRaw: bigint,
  fee: number,
): Promise<{ amountOut: bigint; sqrtPriceX96After: bigint; pool?: Address }> {
  const pancake = pancakeFromConfig();
  const { result } = await client.simulateContract({
    address: pancake.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const [amountOut, sqrtPriceX96After] = result;
  const pool = await resolvePool(client, tokenIn, tokenOut, fee);
  return { amountOut, sqrtPriceX96After, pool };
}

async function quotePath(
  client: PublicClient,
  path: `0x${string}`,
  amountInRaw: bigint,
): Promise<bigint> {
  const pancake = pancakeFromConfig();
  const { result } = await client.simulateContract({
    address: pancake.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInput",
    args: [path, amountInRaw],
  });
  return result[0];
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = await Promise.all(items.slice(i, i + limit).map(fn));
    for (const row of chunk) {
      if (row) out.push(row);
    }
  }
  return out;
}

export async function quoteSwap(args: QuoteArgs): Promise<SwapQuote> {
  const client = args.client ?? getPublicClient();
  const nativeIn = wantsNativeBnb(args.tokenIn);
  const nativeOut = wantsNativeBnb(args.tokenOut);
  if (nativeIn && nativeOut) {
    throw new Error("Native BNB cannot be swapped for native BNB");
  }
  const tokenIn = getToken(args.tokenIn);
  const tokenOut = getToken(args.tokenOut);
  if (tokenIn.address === tokenOut.address) {
    throw new Error("tokenIn and tokenOut must differ");
  }
  const { raw: amountInRaw } = await uiDisplayToRaw(client, tokenIn, args.amountInUi);
  if (amountInRaw <= 0n) throw new Error("amountIn must be > 0");

  const singleFees = quoteFeeTiers(args.fee);
  let lastError: unknown;
  const minTvl = args.minPoolTvlUsd ?? DEFAULT_MIN_QUOTE_TVL_USD;
  const singles = await mapLimit(singleFees, 4, async (fee) => {
    try {
      const q = await quoteSingle(client, tokenIn, tokenOut, amountInRaw, fee);
      let tvlUsd: number | undefined;
      if (q.pool) {
        try {
          tvlUsd = await estimatePoolTvlUsd(client, q.pool);
        } catch {
          tvlUsd = undefined;
        }
      }
      return {
        amountOut: q.amountOut,
        fee,
        pool: q.pool,
        tvlUsd,
        route: "v3-single" as const,
        hops: [{ tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, fee }],
        sqrtPriceX96After: q.sqrtPriceX96After,
      };
    } catch (err) {
      lastError = err;
      return undefined;
    }
  });

  const bestSingle = args.fee ? pickBestQuote(singles, 0) : pickBestQuote(singles, minTvl);
  const thickSingle = singles.some((s) => (s.tvlUsd ?? 0) >= minTvl);
  let best: QuoteCandidate | undefined = bestSingle;

  // Explicit fee = that pool only. Thick single beats a two-hop that only looks richer.
  if (best && (args.fee || thickSingle)) {
    return {
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw: best.amountOut,
      amountInUi: args.amountInUi,
      amountOutUi: await rawToUiDisplay(client, tokenOut, best.amountOut),
      fee: best.fee,
      pool: best.pool,
      route: best.route,
      hops: best.hops,
      sqrtPriceX96After: best.sqrtPriceX96After,
      nativeIn,
      nativeOut,
    };
  }

  const twoHopJobs: Array<{ mid: TokenRecord; fee1: number; fee2: number }> = [];
  for (const mid of quoteBridges(tokenIn, tokenOut)) {
    for (const fee1 of hopFeeTiers(tokenIn, mid)) {
      for (const fee2 of hopFeeTiers(mid, tokenOut)) {
        twoHopJobs.push({ mid, fee1, fee2 });
      }
    }
  }

  const twoHops = await mapLimit(twoHopJobs, 4, async ({ mid, fee1, fee2 }) => {
    try {
      const path = encodeV3Path([
        { token: tokenIn.address, fee: fee1 },
        { token: mid.address, fee: fee2 },
        { token: tokenOut.address },
      ]);
      const amountOut = await quotePath(client, path, amountInRaw);
      return {
        amountOut,
        fee: fee1,
        route: "smart-router" as const,
        hops: [
          { tokenIn: tokenIn.symbol, tokenOut: mid.symbol, fee: fee1 },
          { tokenIn: mid.symbol, tokenOut: tokenOut.symbol, fee: fee2 },
        ],
      };
    } catch (err) {
      lastError = err;
      return undefined;
    }
  });
  for (const row of twoHops) best = richerQuote(best, row);

  if (!best) {
    throw new Error(
      `No V3 quote for ${nativeIn ? "BNB" : tokenIn.symbol}→${nativeOut ? "BNB" : tokenOut.symbol}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  return {
    tokenIn,
    tokenOut,
    amountInRaw,
    amountOutRaw: best.amountOut,
    amountInUi: args.amountInUi,
    amountOutUi: await rawToUiDisplay(client, tokenOut, best.amountOut),
    fee: best.fee,
    pool: best.pool,
    route: best.route,
    hops: best.hops,
    sqrtPriceX96After: best.sqrtPriceX96After,
    nativeIn,
    nativeOut,
  };
}

export async function readPoolState(pool: Address, client: PublicClient = getPublicClient()) {
  const [slot0, liquidity, token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "fee" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "tickSpacing" }),
  ]);
  return {
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    liquidity,
    token0,
    token1,
    fee,
    tickSpacing,
  };
}
