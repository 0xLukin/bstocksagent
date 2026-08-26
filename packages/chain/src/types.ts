import type { Address, Hex } from "viem";

export type TokenKind = "bstock" | "stable" | "gas";

export type TokenRecord = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  scaledUi: boolean;
  kind: TokenKind;
};

export type PoolRecord = {
  id: string;
  token: string;
  quote: string;
  fee: number;
  address?: Address;
  source?: string;
};

export type PancakeAddresses = {
  smartRouter: Address;
  nfpm: Address;
  quoterV2: Address;
  factory: Address;
  swapRouterV3: Address;
  permit2: Address;
};

export type PreparedTx = {
  to: Address;
  data: Hex;
  value: bigint;
  label: string;
};

export type SwapQuote = {
  tokenIn: TokenRecord;
  tokenOut: TokenRecord;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  amountInUi: string;
  amountOutUi: string;
  fee: number;
  pool?: Address;
  route: "v3-single" | "smart-router";
  hops: { tokenIn: string; tokenOut: string; fee: number }[];
  sqrtPriceX96After?: bigint;
  /** User pays native BNB (msg.value). tokenIn is still WBNB for the path. */
  nativeIn: boolean;
  /** User receives native BNB via unwrapWETH9. tokenOut is still WBNB for the path. */
  nativeOut: boolean;
};

export type IntentKind =
  | "swap"
  | "lp-mint"
  | "lp-collect"
  | "lp-increase"
  | "lp-decrease"
  | "approve";

export type UserIntent = {
  id: string;
  kind: IntentKind;
  userAddress: Address;
  chainId: 56;
  createdAt: string;
  expiresAt: string;
  txs: Array<{
    to: Address;
    data: Hex;
    value: string;
    label: string;
  }>;
  summary: Record<string, unknown>;
  risks: string[];
  simulation?: {
    ok: boolean;
    notes: string[];
  };
};
