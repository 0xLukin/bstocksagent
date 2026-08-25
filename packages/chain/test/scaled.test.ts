import { describe, expect, it } from "vitest";
import {
  convertRawToUi,
  convertUiToRaw,
  formatFixed,
  parseFixed,
  UI_MULTIPLIER_ONE,
} from "../src/scaled.js";

describe("ERC-8056 raw↔UI", () => {
  it("is identity when multiplier is 1.0", () => {
    const raw = 123456789000000000n;
    expect(convertRawToUi(raw, UI_MULTIPLIER_ONE)).toBe(raw);
    expect(convertUiToRaw(raw, UI_MULTIPLIER_ONE)).toBe(raw);
  });

  it("doubles UI on a 2-for-1 split without changing raw invertibly", () => {
    const raw = 100n * 10n ** 18n;
    const two = 2n * UI_MULTIPLIER_ONE;
    expect(convertRawToUi(raw, two)).toBe(200n * 10n ** 18n);
    expect(convertUiToRaw(200n * 10n ** 18n, two)).toBe(raw);
  });

  it("never treats UI as raw when multiplier ≠ 1", () => {
    const uiShares = 5n * 10n ** 18n;
    const multiplier = 4n * UI_MULTIPLIER_ONE;
    const rawForContract = convertUiToRaw(uiShares, multiplier);
    expect(rawForContract).toBe(125n * 10n ** 16n);
    expect(rawForContract).not.toBe(uiShares);
  });

  it("parse/format round-trips display strings", () => {
    expect(parseFixed("10.5", 18)).toBe(105n * 10n ** 17n);
    expect(formatFixed(105n * 10n ** 17n, 18)).toBe("10.5");
  });

  it("rejects a zero multiplier", () => {
    expect(() => convertUiToRaw(1n, 0n)).toThrow();
  });
});
