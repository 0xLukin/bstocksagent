import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";

let cached: PublicClient | undefined;

export function getPublicClient(rpcUrl?: string): PublicClient {
  if (cached && !rpcUrl) return cached;
  const primary = rpcUrl ?? process.env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com";
  const fallbackUrl = process.env.BSC_RPC_FALLBACK_URL;
  const transport = fallbackUrl
    ? fallback([http(primary), http(fallbackUrl)])
    : http(primary);
  const client = createPublicClient({
    chain: bsc,
    transport,
  });
  if (!rpcUrl) cached = client;
  return client;
}

export async function assertBsc(client: PublicClient = getPublicClient()): Promise<void> {
  const id = await client.getChainId();
  if (id !== 56) {
    throw new Error(`Expected BSC chainId 56, got ${id}`);
  }
}
