import { privateKeyToAccount } from "viem/accounts";
import type { TermixClient } from "./client.js";
import type { SessionTokens } from "./types.js";

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

export function requireWalletKey(): `0x${string}` {
  const key = process.env.WALLET_KEY;
  if (!key) {
    throw new Error("WALLET_KEY is not set. Termix actions that need a wallet are skipped.");
  }
  return normalizeKey(key);
}

export function buyerWalletKeyOrNull(): `0x${string}` | null {
  const key = process.env.BUYER_WALLET_KEY?.trim();
  if (!key) return null;
  return normalizeKey(key);
}

export function requireBuyerWalletKey(): `0x${string}` {
  const key = buyerWalletKeyOrNull();
  if (!key) {
    throw new Error("BUYER_WALLET_KEY is not set. Add a second BSC wallet to .env (not WALLET_KEY).");
  }
  return key;
}

export async function walletLogin(client: TermixClient, walletKey = requireWalletKey()): Promise<SessionTokens> {
  const account = privateKeyToAccount(walletKey);
  const nonceRes = await client.request<{ nonce: string; message: string }>(`/api/v1/auth/nonce`, {
    method: "POST",
    auth: "none",
    body: JSON.stringify({ walletAddress: account.address }),
  });
  const signature = await account.signMessage({ message: nonceRes.message });
  const session = await client.request<SessionTokens>(`/api/v1/auth/wallet`, {
    method: "POST",
    auth: "none",
    body: JSON.stringify({
      walletAddress: account.address,
      nonce: nonceRes.nonce,
      signature,
    }),
  });
  client.applySession(session);
  return session;
}

export async function refreshSession(client: TermixClient, refreshToken: string): Promise<SessionTokens> {
  const session = await client.request<SessionTokens>(`/api/v1/auth/refresh`, {
    method: "POST",
    auth: "none",
    body: JSON.stringify({ refreshToken }),
  });
  client.applySession(session);
  return session;
}

export async function issueRuntimeToken(
  client: TermixClient,
  agentId: string,
  walletKey = requireWalletKey(),
): Promise<string> {
  const account = privateKeyToAccount(walletKey);
  const timestamp = Date.now();
  // Live skill (termix.ai/skills v1.3.0): AACP:a2a-runtime-token:<agentId>:<ms>
  const message = `AACP:a2a-runtime-token:${agentId}:${timestamp}`;
  const signature = await account.signMessage({ message });
  const res = await client.request<{ token?: string; accessToken?: string }>(
    `/api/v1/a2a/runtime/token/${agentId}`,
    {
      method: "POST",
      auth: "none",
      headers: {
        "x-wallet-address": account.address.toLowerCase(),
        "x-wallet-signature": signature,
        "x-wallet-timestamp": String(timestamp),
      },
    },
  );
  const token = res.token ?? res.accessToken;
  if (!token) throw new Error("Runtime token response missing token");
  client.runtimeToken = token;
  return token;
}
