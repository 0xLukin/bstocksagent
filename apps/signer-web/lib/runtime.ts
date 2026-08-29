/**
 * Production: browser talks to Runtime via NEXT_PUBLIC_RUNTIME_URL (unchanged).
 * next dev: same-origin /api proxy so a local 8787 occupant cannot steal the fetch.
 */
const PROD_RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787";

function intentPath(id: string, suffix = ""): string {
  if (process.env.NODE_ENV === "development") return `/api/intents/${id}${suffix}`;
  return `${PROD_RUNTIME.replace(/\/$/, "")}/intents/${id}${suffix}`;
}

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
  followUpSignerUrl?: string;
  followUpError?: string;
  settledNote?: string;
};

export async function fetchIntent(id: string): Promise<RemoteIntent> {
  const res = await fetch(intentPath(id), { cache: "no-store" });
  if (!res.ok) throw new Error("Intent not found, or Runtime is not running");
  return (await res.json()) as RemoteIntent;
}

export async function cancelIntent(id: string): Promise<RemoteIntent> {
  const res = await fetch(intentPath(id, "/cancel"), { method: "POST" });
  const json = (await res.json()) as { intent?: RemoteIntent; error?: string };
  if (!res.ok) throw new Error(json.error ?? "Cancel failed");
  if (!json.intent) throw new Error("Cancel failed");
  return json.intent;
}

export async function reportTx(id: string, txHash: string, address: string) {
  const res = await fetch(intentPath(id, "/tx"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash, address }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to report the transaction");
  return json;
}
