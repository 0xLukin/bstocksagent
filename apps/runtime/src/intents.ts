import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { PreparedTx } from "@bstocks/chain";

export type StoredIntent = {
  id: string;
  kind: string;
  userAddress: Address;
  chainId: 56;
  createdAt: string;
  expiresAt: string;
  conversationId?: string;
  cancelledAt?: string;
  txs: Array<{ to: Address; data: Hex; value: string; label: string }>;
  summary: Record<string, unknown>;
  risks: string[];
  simulation: { ok: boolean; notes: string[] };
  txHashes: Hex[];
};

export function assertIntentBinding(intent: StoredIntent, connected: string): void {
  if (!isAddress(connected)) {
    throw new Error("Connected wallet address is invalid");
  }
  if (getAddress(connected) !== getAddress(intent.userAddress)) {
    throw new Error("Connected wallet does not match the bound address");
  }
  if (intent.cancelledAt) {
    throw new Error("This intent was cancelled and will not be signed");
  }
  if (Date.parse(intent.expiresAt) <= Date.now()) {
    throw new Error("Intent expired. Ask the agent for a new quote");
  }
}

export class IntentStore {
  constructor(
    private dir: string,
    private ttlMs: number,
  ) {}

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  create(input: {
    kind: string;
    userAddress: Address;
    txs: PreparedTx[];
    summary: Record<string, unknown>;
    risks: string[];
    simulationNotes?: string[];
    simulation?: { ok: boolean; notes: string[] };
    conversationId?: string;
  }): StoredIntent {
    const id = randomUUID();
    const now = new Date();
    const intent: StoredIntent = {
      id,
      kind: input.kind,
      userAddress: getAddress(input.userAddress),
      chainId: 56,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      conversationId: input.conversationId,
      txs: input.txs.map((t) => ({
        to: t.to,
        data: t.data,
        value: t.value.toString(),
        label: t.label,
      })),
      summary: input.summary,
      risks: input.risks,
      simulation: input.simulation ?? {
        ok: true,
        notes: input.simulationNotes ?? ["Encoded locally; the signer page will simulate again."],
      },
      txHashes: [],
    };
    writeFileSync(this.file(id), JSON.stringify(intent, null, 2));
    return intent;
  }

  get(id: string): StoredIntent | undefined {
    const p = this.file(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as StoredIntent;
  }

  cancel(id: string): StoredIntent {
    const intent = this.get(id);
    if (!intent) throw new Error("intent not found");
    if (intent.txs.length > 0 && intent.txHashes.length >= intent.txs.length) {
      throw new Error("Already broadcast. On-chain fills cannot be cancelled. To reverse, place a sell.");
    }
    if (!intent.cancelledAt) {
      intent.cancelledAt = new Date().toISOString();
      writeFileSync(this.file(id), JSON.stringify(intent, null, 2));
    }
    return intent;
  }

  recordTx(id: string, hash: Hex, connected: string): StoredIntent {
    const intent = this.get(id);
    if (!intent) throw new Error("intent not found");
    assertIntentBinding(intent, connected);
    if (!intent.txHashes.includes(hash)) intent.txHashes.push(hash);
    writeFileSync(this.file(id), JSON.stringify(intent, null, 2));
    return intent;
  }

  list(): StoredIntent[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((intent): intent is StoredIntent => Boolean(intent));
  }
}
