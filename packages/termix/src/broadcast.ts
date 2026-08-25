import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { requireWalletKey } from "./auth.js";
import type { TxIntent } from "./types.js";

export async function broadcastIntent(
  intent: TxIntent,
  walletKey = requireWalletKey(),
  rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com",
): Promise<Hex> {
  if (intent.chainId && intent.chainId !== 56) {
    throw new Error(`Refusing to broadcast chainId ${intent.chainId}; this agent is BSC-only`);
  }
  const account = privateKeyToAccount(walletKey);
  const wallet = createWalletClient({
    account,
    chain: bsc,
    transport: http(rpcUrl),
  });
  const to = intent.to ?? intent.contract;
  if (!to) throw new Error("tx-intent missing to/contract");
  const hash = await wallet.sendTransaction({
    to,
    data: intent.callData,
    value: intent.value ? BigInt(intent.value) : 0n,
    chain: bsc,
  });
  return hash;
}
