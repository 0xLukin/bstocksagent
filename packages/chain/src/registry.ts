import { readFileSync } from "node:fs";
import { getAddress, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abis.js";
import { checksum } from "./addresses.js";
import { configPath } from "./paths.js";
import {
  balanceOfUI,
  formatFixed,
  fromUIAmount,
  parseFixed,
  toUIAmount,
  tryScaled,
} from "./scaled.js";
import type { PancakeAddresses, PoolRecord, TokenRecord } from "./types.js";

type TokensFile = {
  chainId: number;
  tokens: Array<{
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    scaledUi: boolean;
    kind: TokenRecord["kind"];
  }>;
};

type PoolsFile = {
  pancake: {
    smartRouter: string;
    nfpm: string;
    quoterV2: string;
    factory: string;
    swapRouterV3: string;
    permit2: string;
  };
  feeTiers: number[];
  preferredFee: number;
  quotePriority: string[];
  pools: Array<{
    id: string;
    token: string;
    quote: string;
    fee: number;
    address?: string;
    source?: string;
  }>;
};

let tokensCache: Map<string, TokenRecord> | undefined;
let poolsCache: PoolsFile | undefined;

export function loadTokens(): Map<string, TokenRecord> {
  if (tokensCache) return tokensCache;
  const file = JSON.parse(readFileSync(configPath("tokens.json"), "utf8")) as TokensFile;
  const map = new Map<string, TokenRecord>();
  for (const t of file.tokens) {
    const rec: TokenRecord = {
      symbol: t.symbol.toUpperCase(),
      name: t.name,
      address: checksum(t.address),
      decimals: t.decimals,
      scaledUi: t.scaledUi,
      kind: t.kind,
    };
    map.set(rec.symbol, rec);
    map.set(rec.address.toLowerCase(), rec);
  }
  tokensCache = map;
  return map;
}

export function loadPoolsFile(): PoolsFile {
  if (poolsCache) return poolsCache;
  poolsCache = JSON.parse(readFileSync(configPath("pools.json"), "utf8")) as PoolsFile;
  return poolsCache;
}

export function pancakeFromConfig(): PancakeAddresses {
  const p = loadPoolsFile().pancake;
  return {
    smartRouter: checksum(p.smartRouter),
    nfpm: checksum(p.nfpm),
    quoterV2: checksum(p.quoterV2),
    factory: checksum(p.factory),
    swapRouterV3: checksum(p.swapRouterV3),
    permit2: checksum(p.permit2),
  };
}

export function getToken(symbolOrAddress: string): TokenRecord {
  const map = loadTokens();
  const key = symbolOrAddress.startsWith("0x")
    ? getAddress(symbolOrAddress).toLowerCase()
    : symbolOrAddress.toUpperCase();
  const rec = map.get(key);
  if (!rec) throw new Error(`Token not on whitelist: ${symbolOrAddress}`);
  return rec;
}

export function isWhitelisted(symbolOrAddress: string): boolean {
  try {
    getToken(symbolOrAddress);
    return true;
  } catch {
    return false;
  }
}

export function listTokens(): TokenRecord[] {
  const seen = new Set<string>();
  const out: TokenRecord[] = [];
  for (const [k, v] of loadTokens()) {
    if (k === v.symbol && !seen.has(v.symbol)) {
      seen.add(v.symbol);
      out.push(v);
    }
  }
  return out;
}

export function configuredPools(): PoolRecord[] {
  return loadPoolsFile().pools.map((p) => ({
    ...p,
    address: p.address ? checksum(p.address) : undefined,
  }));
}

export function findConfiguredPool(tokenA: string, tokenB: string, fee?: number): PoolRecord | undefined {
  const a = getToken(tokenA).symbol;
  const b = getToken(tokenB).symbol;
  return configuredPools().find((p) => {
    const pair = new Set([p.token, p.quote]);
    return pair.has(a) && pair.has(b) && (fee === undefined || p.fee === fee);
  });
}

/**
 * Convert a user-facing (UI) amount into raw units for contract calls.
 * For ERC-8056 tokens this uses fromUIAmount (or local fallback if offline).
 */
export async function uiDisplayToRaw(
  client: PublicClient | undefined,
  token: TokenRecord,
  uiDisplay: string,
): Promise<{ raw: bigint; uiScaled: bigint; uiMultiplier?: bigint }> {
  const uiScaled = parseFixed(uiDisplay, token.decimals);
  if (!token.scaledUi) {
    return { raw: uiScaled, uiScaled };
  }
  if (client) {
    const raw = await fromUIAmount(client, token.address, uiScaled);
    const probe = await tryScaled(client, token.address);
    return { raw, uiScaled, uiMultiplier: probe.uiMultiplier };
  }
  throw new Error(`ERC-8056 token ${token.symbol} requires an RPC client for fromUIAmount`);
}

export async function rawToUiDisplay(
  client: PublicClient | undefined,
  token: TokenRecord,
  raw: bigint,
): Promise<string> {
  if (!token.scaledUi) return formatFixed(raw, token.decimals);
  if (!client) throw new Error(`ERC-8056 token ${token.symbol} requires RPC for toUIAmount`);
  const ui = await toUIAmount(client, token.address, raw);
  return formatFixed(ui, token.decimals);
}

export async function readBalanceUi(
  client: PublicClient,
  token: TokenRecord,
  account: Address,
): Promise<{ raw: bigint; uiDisplay: string }> {
  const raw = await client.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
  if (token.scaledUi) {
    const ui = await balanceOfUI(client, token.address, account);
    return { raw, uiDisplay: formatFixed(ui, token.decimals) };
  }
  return { raw, uiDisplay: formatFixed(raw, token.decimals) };
}
