import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIntentBinding, IntentStore } from "../src/intents.js";

const USER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

describe("intent binding", () => {
  it("binds userAddress and rejects a different wallet", () => {
    const store = new IntentStore(mkdtempSync(join(tmpdir(), "intents-")), 60_000);
    const intent = store.create({
      kind: "swap",
      userAddress: USER,
      txs: [
        {
          to: USER,
          data: "0x",
          value: 0n,
          label: "noop",
        },
      ],
      summary: { demo: true },
      risks: [],
    });
    expect(() => assertIntentBinding(intent, USER)).not.toThrow();
    expect(() => assertIntentBinding(intent, OTHER)).toThrow(/绑定地址/);
  });

  it("rejects expired intents", () => {
    const store = new IntentStore(mkdtempSync(join(tmpdir(), "intents-")), -1);
    const intent = store.create({
      kind: "swap",
      userAddress: USER,
      txs: [{ to: USER, data: "0x", value: 0n, label: "noop" }],
      summary: {},
      risks: [],
    });
    expect(() => assertIntentBinding(intent, USER)).toThrow(/过期/);
  });
});
