import { readFileSync } from "node:fs";
import { getAddress, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abis.js";
import { checksum, PANCAKE_BSC } from "./addresses.js";
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
    aliases?: string[];
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
    for (const alias of derivedAliases(rec, t.aliases)) {
      const existing = map.get(alias);
      if (existing && existing.symbol !== rec.symbol) {
        throw new Error(`Token alias collision: ${alias} → ${existing.symbol} vs ${rec.symbol}`);
      }
      map.set(alias, rec);
    }
  }
  tokensCache = map;
  return map;
}

/** User-facing names (NVDA / bNVDA / 英伟达) map onto the on-chain symbol (NVDAB). */
function derivedAliases(rec: TokenRecord, extra: string[] | undefined): string[] {
  const out = new Set<string>();
  if (rec.kind === "bstock" && rec.symbol.endsWith("B") && rec.symbol.length > 2) {
    const ticker = rec.symbol.slice(0, -1);
    out.add(ticker);
    out.add(`B${ticker}`);
    out.add(`B${rec.symbol}`);
  }
  if (rec.symbol === "WBNB") out.add("BNB");
  for (const a of extra ?? []) {
    const key = a.trim().toUpperCase();
    if (key && key !== rec.symbol) out.add(key);
  }
  return [...out];
}

export function loadPoolsFile(): PoolsFile {
  if (poolsCache) return poolsCache;
  poolsCache = JSON.parse(readFileSync(configPath("pools.json"), "utf8")) as PoolsFile;
  return poolsCache;
}

export function pancakeFromConfig(): PancakeAddresses {
  const p = loadPoolsFile().pancake;
  const permit2 = checksum(p.permit2);
  if (permit2.toLowerCase() !== PANCAKE_BSC.permit2.toLowerCase()) {
    throw new Error(
      `pools.json permit2 ${permit2} is not the canonical Pancake Permit2 ${PANCAKE_BSC.permit2}`,
    );
  }
  return {
    smartRouter: checksum(p.smartRouter),
    nfpm: checksum(p.nfpm),
    quoterV2: checksum(p.quoterV2),
    factory: checksum(p.factory),
    swapRouterV3: checksum(p.swapRouterV3),
    permit2,
  };
}

/** Spoken "BNB" means native gas. "WBNB" stays the ERC-20. */
export function wantsNativeBnb(symbolOrAddress: string): boolean {
  const raw = symbolOrAddress.trim();
  if (!raw || raw.startsWith("0x") || raw.startsWith("0X")) return false;
  const key = raw.toUpperCase();
  return key === "BNB" || key === "NATIVE" || key === "TBNB";
}

/** Keep BNB distinct from WBNB after whitelist lookup. */
export function swapAssetSymbol(symbolOrAddress: string): string {
  if (wantsNativeBnb(symbolOrAddress)) return "BNB";
  return getToken(symbolOrAddress).symbol;
}

export function lookupKey(symbolOrAddress: string): string {
  const raw = symbolOrAddress.trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? getAddress(raw).toLowerCase() : raw.toUpperCase();
}

export function getToken(symbolOrAddress: string): TokenRecord {
  const map = loadTokens();
  const rec = map.get(lookupKey(symbolOrAddress));
  if (!rec) throw new Error(`Token not on whitelist: ${symbolOrAddress}`);
  return rec;
}

export function aliasesFor(symbolOrAddress: string): string[] {
  const rec = getToken(symbolOrAddress);
  const out: string[] = [];
  for (const [k, v] of loadTokens()) {
    if (v.symbol !== rec.symbol) continue;
    if (k === rec.symbol || k === rec.address.toLowerCase()) continue;
    out.push(k);
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export function formatWhitelistForPrompt(): string {
  const lines = listTokens().map((t) => {
    const aliases = aliasesFor(t.symbol);
    const aka = aliases.length ? ` (also ${aliases.join(" / ")})` : "";
    return `- ${t.symbol}${aka}: ${t.name}`;
  });
  return [
    "Current whitelist (on-chain symbol first). NVDA, bNVDA, 英伟达, and NVIDIA all map to NVDAB; same pattern for other names.",
    "Call get_bstock_price / quote_swap first. Do not claim something is off-whitelist without a tool. get_bstock_price returns how much quote asset 1 share is worth. There is no AAPL, COIN, bAAPL, or bCOIN.",
    "Spoken BNB is native BNB in the wallet (tokenIn/tokenOut = BNB). WBNB is the wrapped token. Balances differ — do not substitute one for the other.",
    ...lines,
  ].join("\n");
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

const onchainDecimalsCache = new Map<string, number>();

export function resetOnchainDecimalsCache() {
  onchainDecimalsCache.clear();
}

/** tokens.json is the default; runtime re-reads ERC-20 decimals() and caches by address. */
export async function readOnchainDecimals(
  client: PublicClient,
  address: Address,
  fallback: number,
): Promise<number> {
  const key = address.toLowerCase();
  const cached = onchainDecimalsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = await client.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    });
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      onchainDecimalsCache.set(key, fallback);
      return fallback;
    }
    onchainDecimalsCache.set(key, n);
    return n;
  } catch {
    return fallback;
  }
}

async function decimalsFor(client: PublicClient | undefined, token: TokenRecord): Promise<number> {
  if (!client) return token.decimals;
  return readOnchainDecimals(client, token.address, token.decimals);
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
  const decimals = await decimalsFor(client, token);
  const uiScaled = parseFixed(uiDisplay, decimals);
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
  const decimals = await decimalsFor(client, token);
  if (!token.scaledUi) return formatFixed(raw, decimals);
  if (!client) throw new Error(`ERC-8056 token ${token.symbol} requires RPC for toUIAmount`);
  const ui = await toUIAmount(client, token.address, raw);
  return formatFixed(ui, decimals);
}

export async function readBalanceUi(
  client: PublicClient,
  token: TokenRecord,
  account: Address,
  opts?: { native?: boolean },
): Promise<{ raw: bigint; uiDisplay: string }> {
  const decimals = await decimalsFor(client, token);
  if (opts?.native) {
    const raw = await client.getBalance({ address: account });
    return { raw, uiDisplay: formatFixed(raw, decimals) };
  }
  const raw = await client.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
  if (token.scaledUi) {
    const ui = await balanceOfUI(client, token.address, account);
    return { raw, uiDisplay: formatFixed(ui, decimals) };
  }
  return { raw, uiDisplay: formatFixed(raw, decimals) };
}
