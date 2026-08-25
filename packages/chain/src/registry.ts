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
  return {
    smartRouter: checksum(p.smartRouter),
    nfpm: checksum(p.nfpm),
    quoterV2: checksum(p.quoterV2),
    factory: checksum(p.factory),
    swapRouterV3: checksum(p.swapRouterV3),
    permit2: checksum(p.permit2),
  };
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
    const aka = aliases.length ? `（也称 ${aliases.join(" / ")}）` : "";
    return `- ${t.symbol}${aka}：${t.name}`;
  });
  return [
    "当前白名单（链上 symbol 在前）。用户说 NVDA、bNVDA、英伟达、NVIDIA 时一律按 NVDAB 处理，其它标的同理。",
    "先调用 get_bstock_price / quote_swap，禁止在未查工具时断言「不在白名单」。白名单没有 AAPL、COIN、bAAPL、bCOIN。",
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
