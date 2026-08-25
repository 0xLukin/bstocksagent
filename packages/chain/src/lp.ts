import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { erc20Abi, factoryAbi, nfpmAbi } from "./abis.js";
import { ZERO_ADDRESS } from "./addresses.js";
import { getPublicClient } from "./client.js";
import { findConfiguredPool, getToken, pancakeFromConfig, rawToUiDisplay, uiDisplayToRaw } from "./registry.js";
import { readPoolState } from "./quote.js";
import { applySlippage, rangeAroundTick } from "./ticks.js";
import { boundedApproveTx, currentAllowance } from "./swap.js";
import type { PreparedTx, TokenRecord } from "./types.js";

const UINT128_MAX = (1n << 128n) - 1n;

function sortTokens(a: TokenRecord, b: TokenRecord): [TokenRecord, TokenRecord] {
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
}

export async function resolvePoolAddress(
  token: TokenRecord,
  quote: TokenRecord,
  fee: number,
  client: PublicClient,
): Promise<Address> {
  const configured = findConfiguredPool(token.symbol, quote.symbol, fee);
  if (configured?.address) return configured.address;
  const pool = await client.readContract({
    address: pancakeFromConfig().factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [token.address, quote.address, fee],
  });
  if (pool.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(`No V3 pool for ${token.symbol}/${quote.symbol} fee ${fee}`);
  }
  return pool;
}

/** token1 per token0 in raw units (decimals assumed equal → still works via Q96). */
export function amount1FromAmount0(amount0: bigint, sqrtPriceX96: bigint): bigint {
  return (amount0 * sqrtPriceX96 * sqrtPriceX96) / (2n ** 192n);
}

export type AnalyzeLpResult = {
  pool: Address;
  fee: number;
  tick: number;
  tickSpacing: number;
  liquidity: string;
  token0: string;
  token1: string;
  reserve0Ui: string;
  reserve1Ui: string;
  tvlUsdApprox: string;
  warnings: string[];
};

export async function analyzeLp(args: {
  token: string;
  quote?: string;
  fee?: number;
  client?: PublicClient;
}): Promise<AnalyzeLpResult> {
  const client = args.client ?? getPublicClient();
  const token = getToken(args.token);
  const quote = getToken(args.quote ?? "USDT");
  const fee = args.fee ?? findConfiguredPool(token.symbol, quote.symbol)?.fee ?? 2500;
  const pool = await resolvePoolAddress(token, quote, fee, client);
  const state = await readPoolState(pool, client);
  const t0 = getToken(state.token0);
  const t1 = getToken(state.token1);
  const [bal0, bal1] = await Promise.all([
    client.readContract({ address: t0.address, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
    client.readContract({ address: t1.address, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
  ]);
  const reserve0Ui = await rawToUiDisplay(client, t0, bal0);
  const reserve1Ui = await rawToUiDisplay(client, t1, bal1);
  const quoteIs1 = t1.kind === "stable";
  const tvlUsdApprox = quoteIs1 ? reserve1Ui : reserve0Ui;
  const warnings = [
    "LP 有无常损失（IL）。区间越窄，费率收益越高，但更容易脱区间。",
    "非美股交易时段，链上价格可能相对正股偏离。",
    "bStocks 是证书类敞口，不是直接持股，无投票权。",
  ];
  if (state.liquidity === 0n) warnings.push("当前池子 liquidity 为 0，请勿加仓。");
  return {
    pool,
    fee,
    tick: state.tick,
    tickSpacing: state.tickSpacing,
    liquidity: state.liquidity.toString(),
    token0: t0.symbol,
    token1: t1.symbol,
    reserve0Ui,
    reserve1Ui,
    tvlUsdApprox,
    warnings,
  };
}

export async function readPosition(tokenId: bigint, client: PublicClient = getPublicClient()) {
  const pancake = pancakeFromConfig();
  const pos = await client.readContract({
    address: pancake.nfpm,
    abi: nfpmAbi,
    functionName: "positions",
    args: [tokenId],
  });
  const owner = await client.readContract({
    address: pancake.nfpm,
    abi: nfpmAbi,
    functionName: "ownerOf",
    args: [tokenId],
  });
  const t0 = getToken(pos[2]);
  const t1 = getToken(pos[3]);
  return {
    owner,
    token0: t0,
    token1: t1,
    fee: pos[4],
    tickLower: pos[5],
    tickUpper: pos[6],
    liquidity: pos[7].toString(),
    tokensOwed0: pos[10].toString(),
    tokensOwed1: pos[11].toString(),
    tokensOwed0Ui: await rawToUiDisplay(client, t0, pos[10]),
    tokensOwed1Ui: await rawToUiDisplay(client, t1, pos[11]),
  };
}

export type BuildMintArgs = {
  userAddress: Address;
  token: string;
  quote?: string;
  fee?: number;
  amountTokenUi: string;
  amountQuoteUi?: string;
  rangeBps?: number;
  slippageBps: number;
  deadlineSeconds: number;
  client?: PublicClient;
};

export async function buildMintLpTxs(args: BuildMintArgs): Promise<{
  analysis: AnalyzeLpResult;
  txs: PreparedTx[];
  ticks: { tickLower: number; tickUpper: number };
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}> {
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0 (amountMin != 0)");
  const client = args.client ?? getPublicClient();
  const token = getToken(args.token);
  const quote = getToken(args.quote ?? "USDT");
  const fee = args.fee ?? findConfiguredPool(token.symbol, quote.symbol)?.fee ?? 2500;
  const analysis = await analyzeLp({ token: token.symbol, quote: quote.symbol, fee, client });
  const pool = analysis.pool;
  const state = await readPoolState(pool, client);
  const [token0, token1] = sortTokens(token, quote);
  const rangeBps = args.rangeBps ?? 1000;
  const ticks = rangeAroundTick(state.tick, state.tickSpacing, rangeBps);

  const tokenRaw = (await uiDisplayToRaw(client, token, args.amountTokenUi)).raw;
  let quoteRaw: bigint;
  if (args.amountQuoteUi) {
    quoteRaw = (await uiDisplayToRaw(client, quote, args.amountQuoteUi)).raw;
  } else if (token.address.toLowerCase() === token0.address.toLowerCase()) {
    quoteRaw = amount1FromAmount0(tokenRaw, state.sqrtPriceX96);
  } else {
    // token is token1: invert
    const p = state.sqrtPriceX96;
    quoteRaw = p === 0n ? 0n : (tokenRaw * 2n ** 192n) / (p * p);
  }

  const amount0Desired = token0.symbol === token.symbol ? tokenRaw : quoteRaw;
  const amount1Desired = token1.symbol === token.symbol ? tokenRaw : quoteRaw;
  const amount0Min = applySlippage(amount0Desired, args.slippageBps, "minOut");
  const amount1Min = applySlippage(amount1Desired, args.slippageBps, "minOut");
  if (amount0Min <= 0n || amount1Min <= 0n) {
    throw new Error("amount0Min/amount1Min would be 0 — refusing");
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);
  const pancake = pancakeFromConfig();
  const mintData = encodeFunctionData({
    abi: nfpmAbi,
    functionName: "mint",
    args: [
      {
        token0: token0.address,
        token1: token1.address,
        fee,
        tickLower: ticks.tickLower,
        tickUpper: ticks.tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: args.userAddress,
        deadline,
      },
    ],
  });

  const txs: PreparedTx[] = [];
  const allow0 = await currentAllowance(client, token0.address, args.userAddress, pancake.nfpm);
  const allow1 = await currentAllowance(client, token1.address, args.userAddress, pancake.nfpm);
  if (allow0 < amount0Desired) txs.push(boundedApproveTx(token0.address, pancake.nfpm, amount0Desired));
  if (allow1 < amount1Desired) txs.push(boundedApproveTx(token1.address, pancake.nfpm, amount1Desired));
  txs.push({
    to: pancake.nfpm,
    data: mintData,
    value: 0n,
    label: `mint V3 LP ${token0.symbol}/${token1.symbol} fee ${fee}`,
  });

  return { analysis, txs, ticks, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline };
}

export async function buildCollectTx(args: {
  userAddress: Address;
  tokenId: bigint;
}): Promise<PreparedTx> {
  const pancake = pancakeFromConfig();
  return {
    to: pancake.nfpm,
    data: encodeFunctionData({
      abi: nfpmAbi,
      functionName: "collect",
      args: [
        {
          tokenId: args.tokenId,
          recipient: args.userAddress,
          amount0Max: UINT128_MAX,
          amount1Max: UINT128_MAX,
        },
      ],
    }),
    value: 0n,
    label: `collect fees NFT #${args.tokenId}`,
  };
}
