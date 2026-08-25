import { type Address, type PublicClient } from "viem";
import { factoryAbi, poolAbi, quoterV2Abi } from "./abis.js";
import { ZERO_ADDRESS } from "./addresses.js";
import { getPublicClient } from "./client.js";
import { findConfiguredPool, getToken, pancakeFromConfig } from "./registry.js";
import { rawToUiDisplay, uiDisplayToRaw } from "./registry.js";
import { encodeV3Path } from "./ticks.js";
import type { SwapQuote, TokenRecord } from "./types.js";

export type QuoteArgs = {
  tokenIn: string;
  tokenOut: string;
  amountInUi: string;
  fee?: number;
  client?: PublicClient;
};

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

export async function quoteSwap(args: QuoteArgs): Promise<SwapQuote> {
  const client = args.client ?? getPublicClient();
  const tokenIn = getToken(args.tokenIn);
  const tokenOut = getToken(args.tokenOut);
  if (tokenIn.address === tokenOut.address) {
    throw new Error("tokenIn and tokenOut must differ");
  }
  const { raw: amountInRaw } = await uiDisplayToRaw(client, tokenIn, args.amountInUi);
  if (amountInRaw <= 0n) throw new Error("amountIn must be > 0");

  const preferred = args.fee ?? findConfiguredPool(tokenIn.symbol, tokenOut.symbol)?.fee ?? 2500;
  const fees = args.fee ? [args.fee] : [preferred, 500, 100, 10000].filter((v, i, a) => a.indexOf(v) === i);

  let lastError: unknown;
  for (const fee of fees) {
    try {
      const q = await quoteSingle(client, tokenIn, tokenOut, amountInRaw, fee);
      return {
        tokenIn,
        tokenOut,
        amountInRaw,
        amountOutRaw: q.amountOut,
        amountInUi: args.amountInUi,
        amountOutUi: await rawToUiDisplay(client, tokenOut, q.amountOut),
        fee,
        pool: q.pool,
        route: "v3-single",
        hops: [{ tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, fee }],
        sqrtPriceX96After: q.sqrtPriceX96After,
      };
    } catch (err) {
      lastError = err;
    }
  }

  // Smart Router fallback: two-hop via WBNB (still whitelist-only tokens).
  const wbnb = getToken("WBNB");
  if (tokenIn.symbol !== "WBNB" && tokenOut.symbol !== "WBNB") {
    try {
      const fee1 = findConfiguredPool(tokenIn.symbol, "WBNB")?.fee ?? 2500;
      const fee2 = findConfiguredPool(tokenOut.symbol, "WBNB")?.fee ?? 2500;
      const path = encodeV3Path([
        { token: tokenIn.address, fee: fee1 },
        { token: wbnb.address, fee: fee2 },
        { token: tokenOut.address },
      ]);
      const amountOut = await quotePath(client, path, amountInRaw);
      return {
        tokenIn,
        tokenOut,
        amountInRaw,
        amountOutRaw: amountOut,
        amountInUi: args.amountInUi,
        amountOutUi: await rawToUiDisplay(client, tokenOut, amountOut),
        fee: fee1,
        route: "smart-router",
        hops: [
          { tokenIn: tokenIn.symbol, tokenOut: "WBNB", fee: fee1 },
          { tokenIn: "WBNB", tokenOut: tokenOut.symbol, fee: fee2 },
        ],
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `No V3 quote for ${tokenIn.symbol}→${tokenOut.symbol}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
