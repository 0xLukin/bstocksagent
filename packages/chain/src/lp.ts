import { encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi, factoryAbi, nfpmAbi } from "./abis.js";
import { ZERO_ADDRESS } from "./addresses.js";
import { getPublicClient } from "./client.js";
import { getSqrtRatioAtTick, getAmountsForLiquidity, planLiquidityAmounts } from "./liquidity.js";
import { amount1FromAmount0 } from "./lp-math.js";
import { readPoolState } from "./quote.js";
import {
  findConfiguredPool,
  getToken,
  isWhitelisted,
  pancakeFromConfig,
  rawToUiDisplay,
  uiDisplayToRaw,
} from "./registry.js";
import { boundedApproveTx, currentAllowance } from "./swap.js";
import { applySlippage, rangeAroundTick } from "./ticks.js";
import type { PreparedTx, TokenRecord } from "./types.js";
import {
  DEFAULT_LP_RANGE_BPS,
  formatPrice,
  markPairUsd,
  parseUiNumber,
  quotePerToken,
  rangeLabel,
} from "./valuation.js";

export { amount1FromAmount0 } from "./lp-math.js";
export { DEFAULT_LP_RANGE_BPS };

const UINT128_MAX = (1n << 128n) - 1n;
const MAX_ENUMERATE = 40;
let usdPerGasCache: { at: number; value: number } | undefined;

/** Mid WBNB/USDT from the first live V3 fee tier. Cached 30s. */
export async function readUsdPerGas(client: PublicClient): Promise<number> {
  if (usdPerGasCache && Date.now() - usdPerGasCache.at < 30_000) return usdPerGasCache.value;
  const wbnb = getToken("WBNB");
  const usdt = getToken("USDT");
  for (const fee of [2500, 500, 10000, 100]) {
    try {
      const pool = await resolvePoolAddress(wbnb, usdt, fee, client);
      const state = await readPoolState(pool, client);
      const mid = quotePerToken({
        token: wbnb,
        quote: usdt,
        token0: getToken(state.token0),
        token1: getToken(state.token1),
        sqrtPriceX96: state.sqrtPriceX96,
      });
      if (mid > 0) {
        usdPerGasCache = { at: Date.now(), value: mid };
        return mid;
      }
    } catch {
      /* next fee */
    }
  }
  return usdPerGasCache?.value ?? 0;
}

function sortTokens(a: TokenRecord, b: TokenRecord): [TokenRecord, TokenRecord] {
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
}

export function assertPositionOwner(owner: string, user: string): void {
  if (getAddress(owner) !== getAddress(user)) {
    throw new Error("This LP NFT is not owned by the bound wallet.");
  }
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
  midQuotePerToken: string;
  suggestedRangeBps: number;
  suggestedTicks: { tickLower: number; tickUpper: number };
  priceLower: string;
  priceUpper: string;
  warnings: string[];
};

function pairWarnings(liquidity: bigint): string[] {
  const warnings = [
    "LP can incur impermanent loss. Tighter ranges earn more fees but exit range more easily.",
    "Off US-market hours, on-chain price may deviate from the underlying.",
    "bStocks are certificate-style exposure, not direct equity, and have no voting rights. No APR is promised.",
  ];
  if (liquidity === 0n) warnings.push("Pool liquidity is 0. Do not add.");
  return warnings;
}

export function rangePrices(args: {
  token: TokenRecord;
  quote: TokenRecord;
  token0: TokenRecord;
  token1: TokenRecord;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96: bigint;
}): { mid: number; lower: number; upper: number; label: string } {
  const at = (sqrt: bigint) =>
    quotePerToken({
      token: args.token,
      quote: args.quote,
      token0: args.token0,
      token1: args.token1,
      sqrtPriceX96: sqrt,
    });
  const mid = at(args.sqrtPriceX96);
  const a = at(getSqrtRatioAtTick(args.tickLower));
  const b = at(getSqrtRatioAtTick(args.tickUpper));
  const lower = Math.min(a, b);
  const upper = Math.max(a, b);
  return {
    mid,
    lower,
    upper,
    label: `${formatPrice(lower)}–${formatPrice(upper)} ${args.quote.symbol}/${args.token.symbol}`,
  };
}

export async function analyzeLp(args: {
  token: string;
  quote?: string;
  fee?: number;
  rangeBps?: number;
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
  const usdPerGas = t0.kind === "gas" || t1.kind === "gas" ? await readUsdPerGas(client) : undefined;
  const tvl = markPairUsd({
    token0: t0,
    token1: t1,
    amount0Ui: reserve0Ui,
    amount1Ui: reserve1Ui,
    sqrtPriceX96: state.sqrtPriceX96,
    usdPerGas,
  });
  const rangeBps = args.rangeBps ?? DEFAULT_LP_RANGE_BPS;
  const ticks = rangeAroundTick(state.tick, state.tickSpacing, rangeBps);
  const prices = rangePrices({
    token,
    quote,
    token0: t0,
    token1: t1,
    tickLower: ticks.tickLower,
    tickUpper: ticks.tickUpper,
    sqrtPriceX96: state.sqrtPriceX96,
  });
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
    tvlUsdApprox: tvl.toFixed(2),
    midQuotePerToken: formatPrice(prices.mid),
    suggestedRangeBps: rangeBps,
    suggestedTicks: ticks,
    priceLower: formatPrice(prices.lower),
    priceUpper: formatPrice(prices.upper),
    warnings: pairWarnings(state.liquidity),
  };
}

export type PositionSnapshot = {
  tokenId: string;
  owner: Address;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  liquidity: string;
  amount0Ui: string;
  amount1Ui: string;
  tokensOwed0Ui: string;
  tokensOwed1Ui: string;
  markUsd: string;
  feesUsdApprox: string;
  priceLower: string;
  priceUpper: string;
  midQuotePerToken: string;
};

async function snapshotPosition(
  tokenId: bigint,
  client: PublicClient,
): Promise<PositionSnapshot & { token0Rec: TokenRecord; token1Rec: TokenRecord; pool: Address }> {
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
  const fee = pos[4];
  const tickLower = pos[5];
  const tickUpper = pos[6];
  const liquidity = pos[7];
  const pool = await resolvePoolAddress(t0, t1, fee, client);
  const state = await readPoolState(pool, client);
  const used = getAmountsForLiquidity(
    state.sqrtPriceX96,
    getSqrtRatioAtTick(tickLower),
    getSqrtRatioAtTick(tickUpper),
    liquidity,
  );
  const amount0Ui = await rawToUiDisplay(client, t0, used.amount0);
  const amount1Ui = await rawToUiDisplay(client, t1, used.amount1);
  const tokensOwed0Ui = await rawToUiDisplay(client, t0, pos[10]);
  const tokensOwed1Ui = await rawToUiDisplay(client, t1, pos[11]);
  const quote = t0.kind === "stable" ? t0 : t1.kind === "stable" ? t1 : t1;
  const token = t0.kind === "bstock" ? t0 : t1.kind === "bstock" ? t1 : t0;
  const prices = rangePrices({
    token,
    quote,
    token0: t0,
    token1: t1,
    tickLower,
    tickUpper,
    sqrtPriceX96: state.sqrtPriceX96,
  });
  const usdPerGas = t0.kind === "gas" || t1.kind === "gas" ? await readUsdPerGas(client) : undefined;
  const mark = markPairUsd({
    token0: t0,
    token1: t1,
    amount0Ui,
    amount1Ui,
    sqrtPriceX96: state.sqrtPriceX96,
    usdPerGas,
  });
  const fees = markPairUsd({
    token0: t0,
    token1: t1,
    amount0Ui: tokensOwed0Ui,
    amount1Ui: tokensOwed1Ui,
    sqrtPriceX96: state.sqrtPriceX96,
    usdPerGas,
  });
  return {
    tokenId: tokenId.toString(),
    owner,
    token0: t0.symbol,
    token1: t1.symbol,
    fee,
    tickLower,
    tickUpper,
    currentTick: state.tick,
    inRange: tickLower <= state.tick && state.tick < tickUpper,
    liquidity: liquidity.toString(),
    amount0Ui,
    amount1Ui,
    tokensOwed0Ui,
    tokensOwed1Ui,
    markUsd: mark.toFixed(2),
    feesUsdApprox: fees.toFixed(4),
    priceLower: formatPrice(prices.lower),
    priceUpper: formatPrice(prices.upper),
    midQuotePerToken: formatPrice(prices.mid),
    token0Rec: t0,
    token1Rec: t1,
    pool,
  };
}

export async function readPosition(tokenId: bigint, client: PublicClient = getPublicClient()) {
  const snap = await snapshotPosition(tokenId, client);
  return {
    owner: snap.owner,
    token0: snap.token0Rec,
    token1: snap.token1Rec,
    fee: snap.fee,
    tickLower: snap.tickLower,
    tickUpper: snap.tickUpper,
    liquidity: snap.liquidity,
    tokensOwed0: "0",
    tokensOwed1: "0",
    tokensOwed0Ui: snap.tokensOwed0Ui,
    tokensOwed1Ui: snap.tokensOwed1Ui,
    snapshot: snap,
  };
}

export async function listPositions(
  owner: Address,
  client: PublicClient = getPublicClient(),
): Promise<PositionSnapshot[]> {
  const pancake = pancakeFromConfig();
  const count = await client.readContract({
    address: pancake.nfpm,
    abi: nfpmAbi,
    functionName: "balanceOf",
    args: [owner],
  });
  const n = Number(count > BigInt(MAX_ENUMERATE) ? BigInt(MAX_ENUMERATE) : count);
  const out: PositionSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const tokenId = await client.readContract({
      address: pancake.nfpm,
      abi: nfpmAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, BigInt(i)],
    });
    try {
      const snap = await snapshotPosition(tokenId, client);
      if (!isWhitelisted(snap.token0) || !isWhitelisted(snap.token1)) continue;
      if (snap.liquidity === "0" && Number(snap.feesUsdApprox) <= 0) continue;
      out.push({
        tokenId: snap.tokenId,
        owner: snap.owner,
        token0: snap.token0,
        token1: snap.token1,
        fee: snap.fee,
        tickLower: snap.tickLower,
        tickUpper: snap.tickUpper,
        currentTick: snap.currentTick,
        inRange: snap.inRange,
        liquidity: snap.liquidity,
        amount0Ui: snap.amount0Ui,
        amount1Ui: snap.amount1Ui,
        tokensOwed0Ui: snap.tokensOwed0Ui,
        tokensOwed1Ui: snap.tokensOwed1Ui,
        markUsd: snap.markUsd,
        feesUsdApprox: snap.feesUsdApprox,
        priceLower: snap.priceLower,
        priceUpper: snap.priceUpper,
        midQuotePerToken: snap.midQuotePerToken,
      });
    } catch {
      /* not a whitelist pair or unreadable */
    }
  }
  return out;
}

export type BuildMintArgs = {
  userAddress: Address;
  token: string;
  quote?: string;
  fee?: number;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  rangeBps?: number;
  slippageBps: number;
  deadlineSeconds: number;
  client?: PublicClient;
};

export type MintPlan = {
  analysis: AnalyzeLpResult;
  txs: PreparedTx[];
  ticks: { tickLower: number; tickUpper: number };
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
  summary: Record<string, unknown>;
};

async function planPairAmounts(args: {
  client: PublicClient;
  token: TokenRecord;
  quote: TokenRecord;
  token0: TokenRecord;
  token1: TokenRecord;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  budgetQuoteUi?: string;
  sqrtPriceX96: bigint;
  ticks: { tickLower: number; tickUpper: number };
}): Promise<{ amount0: bigint; amount1: bigint; liquidity: bigint }> {
  if (args.budgetQuoteUi) {
    return planBudgetAmounts(args);
  }
  const tokenRaw = args.amountTokenUi
    ? (await uiDisplayToRaw(args.client, args.token, args.amountTokenUi)).raw
    : 0n;
  const quoteRaw = args.amountQuoteUi
    ? (await uiDisplayToRaw(args.client, args.quote, args.amountQuoteUi)).raw
    : 0n;
  if (tokenRaw <= 0n && quoteRaw <= 0n) {
    throw new Error("Mint needs a share amount, stable amount, or total budget (e.g. 100 USDT).");
  }
  const amount0Desired = args.token0.symbol === args.token.symbol ? tokenRaw : quoteRaw;
  const amount1Desired = args.token1.symbol === args.token.symbol ? tokenRaw : quoteRaw;
  return planLiquidityAmounts({
    sqrtPriceX96: args.sqrtPriceX96,
    tickLower: args.ticks.tickLower,
    tickUpper: args.ticks.tickUpper,
    amount0Desired,
    amount1Desired,
  });
}

async function planBudgetAmounts(args: {
  client: PublicClient;
  token: TokenRecord;
  quote: TokenRecord;
  token0: TokenRecord;
  token1: TokenRecord;
  budgetQuoteUi?: string;
  sqrtPriceX96: bigint;
  ticks: { tickLower: number; tickUpper: number };
}): Promise<{ amount0: bigint; amount1: bigint; liquidity: bigint }> {
  const budget = parseUiNumber(args.budgetQuoteUi);
  if (!(budget > 0)) throw new Error("LP budget must be greater than 0");
  const half = (budget / 2).toFixed(8);
  const seed = await planPairAmounts({
    ...args,
    amountQuoteUi: half,
    amountTokenUi: undefined,
    budgetQuoteUi: undefined,
  });
  const amount0Ui = await rawToUiDisplay(args.client, args.token0, seed.amount0);
  const amount1Ui = await rawToUiDisplay(args.client, args.token1, seed.amount1);
  const needGasUsd = args.token0.kind === "gas" || args.token1.kind === "gas";
  const usdPerGas = needGasUsd ? await readUsdPerGas(args.client) : undefined;
  const mark = markPairUsd({
    token0: args.token0,
    token1: args.token1,
    amount0Ui,
    amount1Ui,
    sqrtPriceX96: args.sqrtPriceX96,
    usdPerGas,
  });
  if (needGasUsd && !(usdPerGas && usdPerGas > 0)) {
    throw new Error("Cannot size a WBNB pool from a USD budget. Give a share amount or use a USDT pool.");
  }
  if (!(mark > 0)) throw new Error("Cannot size the position from budget. Give a share amount instead.");
  const scale = BigInt(Math.max(1, Math.round((budget / mark) * 1_000_000)));
  return planLiquidityAmounts({
    sqrtPriceX96: args.sqrtPriceX96,
    tickLower: args.ticks.tickLower,
    tickUpper: args.ticks.tickUpper,
    amount0Desired: (seed.amount0 * scale) / 1_000_000n,
    amount1Desired: (seed.amount1 * scale) / 1_000_000n,
  });
}

function lpMintSummary(args: {
  analysis: AnalyzeLpResult;
  token: TokenRecord;
  quote: TokenRecord;
  token0: TokenRecord;
  token1: TokenRecord;
  ticks: { tickLower: number; tickUpper: number };
  amount0Ui: string;
  amount1Ui: string;
  amount0MinUi: string;
  amount1MinUi: string;
  rangeBps: number;
  sqrtPriceX96: bigint;
}): Record<string, unknown> {
  const prices = rangePrices({
    token: args.token,
    quote: args.quote,
    token0: args.token0,
    token1: args.token1,
    tickLower: args.ticks.tickLower,
    tickUpper: args.ticks.tickUpper,
    sqrtPriceX96: args.sqrtPriceX96,
  });
  return {
    token: args.token.symbol,
    quote: args.quote.symbol,
    token0: args.token0.symbol,
    token1: args.token1.symbol,
    amount0Ui: args.amount0Ui,
    amount1Ui: args.amount1Ui,
    amount0MinUi: args.amount0MinUi,
    amount1MinUi: args.amount1MinUi,
    fee: args.analysis.fee,
    rangeBps: args.rangeBps,
    rangeLabel: rangeLabel(args.rangeBps),
    ticks: args.ticks,
    priceLower: formatPrice(prices.lower),
    priceUpper: formatPrice(prices.upper),
    midQuotePerToken: formatPrice(prices.mid),
    rangePrices: prices.label,
    analysis: args.analysis,
  };
}

export async function buildMintLpTxs(args: BuildMintArgs): Promise<MintPlan> {
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0 (amountMin != 0)");
  if (!args.amountTokenUi && !args.amountQuoteUi && !args.budgetQuoteUi) {
    throw new Error("Mint needs a share amount, stable amount, or total budget");
  }
  const client = args.client ?? getPublicClient();
  const token = getToken(args.token);
  const quote = getToken(args.quote ?? "USDT");
  const fee = args.fee ?? findConfiguredPool(token.symbol, quote.symbol)?.fee ?? 2500;
  const rangeBps = args.rangeBps ?? DEFAULT_LP_RANGE_BPS;
  const analysis = await analyzeLp({ token: token.symbol, quote: quote.symbol, fee, rangeBps, client });
  const pool = analysis.pool;
  const state = await readPoolState(pool, client);
  const [token0, token1] = sortTokens(token, quote);
  const ticks = rangeAroundTick(state.tick, state.tickSpacing, rangeBps);
  const planned = await planPairAmounts({
    client,
    token,
    quote,
    token0,
    token1,
    amountTokenUi: args.amountTokenUi,
    amountQuoteUi: args.amountQuoteUi,
    budgetQuoteUi: args.budgetQuoteUi,
    sqrtPriceX96: state.sqrtPriceX96,
    ticks,
  });
  if (planned.liquidity <= 0n || (planned.amount0 <= 0n && planned.amount1 <= 0n)) {
    throw new Error("Could not compute a valid position size. Give both share and stable amounts, or use a wider range.");
  }

  const amount0Desired = planned.amount0;
  const amount1Desired = planned.amount1;
  const amount0Min = amount0Desired > 0n ? applySlippage(amount0Desired, args.slippageBps, "minOut") : 0n;
  const amount1Min = amount1Desired > 0n ? applySlippage(amount1Desired, args.slippageBps, "minOut") : 0n;
  if (amount0Desired > 0n && amount0Min <= 0n) throw new Error("amount0Min would be 0 — refusing");
  if (amount1Desired > 0n && amount1Min <= 0n) throw new Error("amount1Min would be 0 — refusing");
  if (amount0Min <= 0n && amount1Min <= 0n) throw new Error("amount0Min/amount1Min would be 0 — refusing");

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
  if (amount0Desired > 0n && allow0 < amount0Desired) {
    txs.push(boundedApproveTx(token0.address, pancake.nfpm, amount0Desired));
  }
  if (amount1Desired > 0n && allow1 < amount1Desired) {
    txs.push(boundedApproveTx(token1.address, pancake.nfpm, amount1Desired));
  }
  txs.push({
    to: pancake.nfpm,
    data: mintData,
    value: 0n,
    label: `mint V3 LP ${token0.symbol}/${token1.symbol} fee ${fee} ${rangeLabel(rangeBps)}`,
  });

  const amount0Ui = await rawToUiDisplay(client, token0, amount0Desired);
  const amount1Ui = await rawToUiDisplay(client, token1, amount1Desired);
  const summary = lpMintSummary({
    analysis,
    token,
    quote,
    token0,
    token1,
    ticks,
    amount0Ui,
    amount1Ui,
    amount0MinUi: await rawToUiDisplay(client, token0, amount0Min),
    amount1MinUi: await rawToUiDisplay(client, token1, amount1Min),
    rangeBps,
    sqrtPriceX96: state.sqrtPriceX96,
  });

  return { analysis, txs, ticks, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline, summary };
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

export async function buildIncreaseLpTxs(args: {
  userAddress: Address;
  tokenId: bigint;
  amountTokenUi?: string;
  amountQuoteUi?: string;
  slippageBps: number;
  deadlineSeconds: number;
  client?: PublicClient;
}): Promise<{ txs: PreparedTx[]; summary: Record<string, unknown>; analysis: AnalyzeLpResult; amount0Min: bigint }> {
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0");
  const client = args.client ?? getPublicClient();
  const snap = await snapshotPosition(args.tokenId, client);
  assertPositionOwner(snap.owner, args.userAddress);
  const token0 = snap.token0Rec;
  const token1 = snap.token1Rec;
  const token = token0.kind === "bstock" ? token0 : token1;
  const quote = token0.kind === "stable" ? token0 : token1;
  const pool = snap.pool;
  const state = await readPoolState(pool, client);
  const planned = await planPairAmounts({
    client,
    token,
    quote,
    token0,
    token1,
    amountTokenUi: args.amountTokenUi,
    amountQuoteUi: args.amountQuoteUi,
    sqrtPriceX96: state.sqrtPriceX96,
    ticks: { tickLower: snap.tickLower, tickUpper: snap.tickUpper },
  });
  const amount0Min = planned.amount0 > 0n ? applySlippage(planned.amount0, args.slippageBps, "minOut") : 0n;
  const amount1Min = planned.amount1 > 0n ? applySlippage(planned.amount1, args.slippageBps, "minOut") : 0n;
  if (planned.liquidity <= 0n) throw new Error("Increase size is invalid");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);
  const pancake = pancakeFromConfig();
  const txs: PreparedTx[] = [];
  const allow0 = await currentAllowance(client, token0.address, args.userAddress, pancake.nfpm);
  const allow1 = await currentAllowance(client, token1.address, args.userAddress, pancake.nfpm);
  if (planned.amount0 > 0n && allow0 < planned.amount0) {
    txs.push(boundedApproveTx(token0.address, pancake.nfpm, planned.amount0));
  }
  if (planned.amount1 > 0n && allow1 < planned.amount1) {
    txs.push(boundedApproveTx(token1.address, pancake.nfpm, planned.amount1));
  }
  txs.push({
    to: pancake.nfpm,
    data: encodeFunctionData({
      abi: nfpmAbi,
      functionName: "increaseLiquidity",
      args: [
        {
          tokenId: args.tokenId,
          amount0Desired: planned.amount0,
          amount1Desired: planned.amount1,
          amount0Min,
          amount1Min,
          deadline,
        },
      ],
    }),
    value: 0n,
    label: `increase V3 LP NFT #${args.tokenId}`,
  });
  const analysis = await analyzeLp({ token: token.symbol, quote: quote.symbol, fee: snap.fee, client });
  const summary = {
    ...lpMintSummary({
      analysis,
      token,
      quote,
      token0,
      token1,
      ticks: { tickLower: snap.tickLower, tickUpper: snap.tickUpper },
      amount0Ui: await rawToUiDisplay(client, token0, planned.amount0),
      amount1Ui: await rawToUiDisplay(client, token1, planned.amount1),
      amount0MinUi: await rawToUiDisplay(client, token0, amount0Min),
      amount1MinUi: await rawToUiDisplay(client, token1, amount1Min),
      rangeBps: 0,
      sqrtPriceX96: state.sqrtPriceX96,
    }),
    tokenId: args.tokenId.toString(),
    rangeLabel: `${formatPrice(Number(snap.priceLower))}–${formatPrice(Number(snap.priceUpper))}`,
  };
  return { txs, summary, analysis, amount0Min: amount0Min > 0n ? amount0Min : 1n };
}

export async function buildDecreaseLpTxs(args: {
  userAddress: Address;
  tokenId: bigint;
  decreaseBps: number;
  slippageBps: number;
  deadlineSeconds: number;
  client?: PublicClient;
}): Promise<{ txs: PreparedTx[]; summary: Record<string, unknown>; analysis: AnalyzeLpResult; amount0Min: bigint }> {
  if (args.decreaseBps <= 0 || args.decreaseBps > 10_000) throw new Error("decreaseBps must be 1–10000");
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0");
  const client = args.client ?? getPublicClient();
  const snap = await snapshotPosition(args.tokenId, client);
  assertPositionOwner(snap.owner, args.userAddress);
  const liquidity = BigInt(snap.liquidity);
  if (liquidity <= 0n) throw new Error("This position has no liquidity to withdraw.");
  const take = (liquidity * BigInt(args.decreaseBps)) / 10_000n;
  if (take <= 0n) throw new Error("Withdraw share is too small.");
  const used = getAmountsForLiquidity(
    (await readPoolState(snap.pool, client)).sqrtPriceX96,
    getSqrtRatioAtTick(snap.tickLower),
    getSqrtRatioAtTick(snap.tickUpper),
    take,
  );
  const amount0Min = used.amount0 > 0n ? applySlippage(used.amount0, args.slippageBps, "minOut") : 0n;
  const amount1Min = used.amount1 > 0n ? applySlippage(used.amount1, args.slippageBps, "minOut") : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);
  const pancake = pancakeFromConfig();
  const burn = take >= liquidity;
  const calls: Hex[] = [
    encodeFunctionData({
      abi: nfpmAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: args.tokenId,
          liquidity: take,
          amount0Min,
          amount1Min,
          deadline,
        },
      ],
    }),
    encodeFunctionData({
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
  ];
  if (burn) {
    calls.push(
      encodeFunctionData({
        abi: nfpmAbi,
        functionName: "burn",
        args: [args.tokenId],
      }),
    );
  }
  const txs: PreparedTx[] = [
    {
      to: pancake.nfpm,
      data: encodeFunctionData({
        abi: nfpmAbi,
        functionName: "multicall",
        args: [calls],
      }),
      value: 0n,
      label: burn
        ? `withdraw+burn V3 LP NFT #${args.tokenId}`
        : `decrease V3 LP NFT #${args.tokenId} ${args.decreaseBps}bps`,
    },
  ];
  const token = snap.token0Rec.kind === "bstock" ? snap.token0Rec : snap.token1Rec;
  const quote = snap.token0Rec.kind === "stable" ? snap.token0Rec : snap.token1Rec;
  const analysis = await analyzeLp({ token: token.symbol, quote: quote.symbol, fee: snap.fee, client });
  const summary = {
    tokenId: args.tokenId.toString(),
    token0: snap.token0,
    token1: snap.token1,
    amount0Ui: await rawToUiDisplay(client, snap.token0Rec, used.amount0),
    amount1Ui: await rawToUiDisplay(client, snap.token1Rec, used.amount1),
    decreaseBps: args.decreaseBps,
    burn,
    fee: snap.fee,
    analysis,
  };
  return { txs, summary, analysis, amount0Min: amount0Min > 0n ? amount0Min : 1n };
}
