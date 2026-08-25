import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { latchGeoConfirm, latchUserConfirm } from "@bstocks/risk";

export type ConversationState = {
  id: string;
  wallet?: Address;
  geoConfirmed: boolean;
  userConfirmed: boolean;
  pendingAction?: string;
  lastOrderId?: string;
  lastOfferHint?: string;
  preference?: string;
  updatedAt: string;
};

export class ConversationStore {
  constructor(private dir: string) {}

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  get(id: string): ConversationState {
    const p = this.file(id);
    if (!existsSync(p)) {
      return {
        id,
        geoConfirmed: false,
        userConfirmed: false,
        updatedAt: new Date().toISOString(),
      };
    }
    return JSON.parse(readFileSync(p, "utf8")) as ConversationState;
  }

  save(state: ConversationState) {
    state.updatedAt = new Date().toISOString();
    writeFileSync(this.file(state.id), JSON.stringify(state, null, 2));
  }

  ingestUserText(id: string, text: string): ConversationState {
    const s = this.get(id);
    s.geoConfirmed = latchGeoConfirm(s.geoConfirmed, text);
    s.userConfirmed = latchUserConfirm(s.userConfirmed, text);
    const wallet = text.match(/0x[a-fA-F0-9]{40}/);
    if (wallet) s.wallet = wallet[0] as Address;
    this.save(s);
    return s;
  }

  consumeConfirm(id: string) {
    const s = this.get(id);
    s.userConfirmed = false;
    this.save(s);
    return s;
  }
}
