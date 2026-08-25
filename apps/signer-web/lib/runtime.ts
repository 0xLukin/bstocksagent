const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787";

export type IntentTx = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  label: string;
};

export type RemoteIntent = {
  id: string;
  kind: string;
  userAddress: `0x${string}`;
  chainId: 56;
  createdAt: string;
  expiresAt: string;
  txs: IntentTx[];
  summary: Record<string, unknown>;
  risks: string[];
  simulation: { ok: boolean; notes: string[] };
  txHashes: string[];
  conversationId?: string;
  cancelledAt?: string;
};

export async function fetchIntent(id: string): Promise<RemoteIntent> {
  const res = await fetch(`${RUNTIME}/intents/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error("找不到该意图，或 Runtime 未启动");
  return (await res.json()) as RemoteIntent;
}

export async function cancelIntent(id: string): Promise<RemoteIntent> {
  const res = await fetch(`${RUNTIME}/intents/${id}/cancel`, { method: "POST" });
  const json = (await res.json()) as { intent?: RemoteIntent; error?: string };
  if (!res.ok) throw new Error(json.error ?? "取消失败");
  if (!json.intent) throw new Error("取消失败");
  return json.intent;
}

export async function reportTx(id: string, txHash: string, address: string) {
  const res = await fetch(`${RUNTIME}/intents/${id}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash, address }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "回传失败");
  return json;
}
