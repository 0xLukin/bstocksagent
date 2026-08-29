import { describe, expect, it } from "vitest";
import { serializeToolResult } from "../src/tools.js";

describe("serializeToolResult", () => {
  it("stringifies bigint so read_balance can return JSON", () => {
    const json = serializeToolResult({ raw: 10_000_000_000_000_000n, uiDisplay: "0.01", symbol: "BNB" });
    expect(JSON.parse(json)).toEqual({
      raw: "10000000000000000",
      uiDisplay: "0.01",
      symbol: "BNB",
    });
  });
});
