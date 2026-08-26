import { describe, expect, it } from "vitest";
import {
  aliasesFor,
  formatWhitelistForPrompt,
  getToken,
  isWhitelisted,
} from "../src/registry.js";

describe("token aliases", () => {
  it("maps NVDA / bNVDA / 英伟达 onto NVDAB", () => {
    for (const q of ["NVDAB", "nvda", "bNVDA", "bNVDAB", "NVIDIA", "英伟达"]) {
      expect(getToken(q).symbol).toBe("NVDAB");
      expect(isWhitelisted(q)).toBe(true);
    }
  });

  it("maps other spoken names onto on-chain symbols", () => {
    expect(getToken("微软").symbol).toBe("MSFTB");
    expect(getToken("特斯拉").symbol).toBe("TSLAB");
    expect(getToken("bnb").symbol).toBe("WBNB");
    expect(getToken("bnb").kind).toBe("gas");
  });

  it("still rejects names that are not listed", () => {
    expect(isWhitelisted("AAPL")).toBe(false);
    expect(isWhitelisted("bCOIN")).toBe(false);
    expect(() => getToken("NVDA股票")).toThrow(/not on whitelist/);
  });

  it("lists aliases for the prompt", () => {
    const aliases = aliasesFor("NVDAB");
    expect(aliases).toEqual(expect.arrayContaining(["NVDA", "BNVDA", "NVIDIA", "英伟达"]));
    const prompt = formatWhitelistForPrompt();
    expect(prompt).toContain("NVDAB");
    expect(prompt).toContain("英伟达");
    expect(prompt).toMatch(/没有 AAPL/);
  });
});
