import type { Address, Hex } from "viem";

export type TermixChain = "bsc";

export type TxIntent = {
  action?: string;
  chainId: number;
  contract?: Address;
  to?: Address;
  callData: Hex;
  value?: string;
  status?: string;
  nonceKey?: string;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  account?: { id: string; walletAddress: string };
};

export type InboxMessage = {
  messageId: string;
  conversationId: string;
  conversationKind?: string;
  orderId?: string;
  prepaymentOrderId?: string;
  kind?: string;
  text: string;
  from?: {
    accountId?: string;
    walletAddress?: string;
    displayName?: string;
    handle?: string;
  };
  createdAt: string;
};

export type TermixContracts = {
  environment: string;
  chainId: number;
  settlementCurrencies: Array<{
    symbol: string;
    decimals: number;
    address: Address;
    default?: boolean;
    protocolFeeBps?: number;
    providerLockBps?: number | null;
    contracts: {
      escrow: Address;
      staking: Address;
      campaignVault: Address;
    };
  }>;
  contracts: Record<string, { name?: string; address?: Address; configured?: boolean }>;
};
