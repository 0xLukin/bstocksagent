import { describe, expect, it } from "vitest";
import { resolveDataDir, resolveLlmConfig } from "../src/config.js";

describe("resolveLlmConfig", () => {
  it("prefers DeepSeek and ignores leftover OpenRouter defaults", () => {
    const cfg = resolveLlmConfig({
      DEEPSEEK_API_KEY: "sk-ds-test",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      A2A_LLM_MODEL: "openai/gpt-4o-mini",
    });
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.llmBase).toBe("https://api.deepseek.com");
    expect(cfg.llmModel).toBe("deepseek-v4-flash");
    expect(cfg.llmKey).toBe("sk-ds-test");
  });

  it("honors explicit DeepSeek model override", () => {
    const cfg = resolveLlmConfig({
      DEEPSEEK_API_KEY: "sk-ds-test",
      A2A_LLM_MODEL: "deepseek-v4-pro",
    });
    expect(cfg.llmModel).toBe("deepseek-v4-pro");
  });

  it("falls back to OpenRouter when DeepSeek key is absent", () => {
    const cfg = resolveLlmConfig({
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.llmBase).toBe("https://openrouter.ai/api/v1");
  });

  it("is none without any key", () => {
    expect(resolveLlmConfig({}).provider).toBe("none");
  });

  it("resolves relative DATA_DIR against the repo root", () => {
    expect(resolveDataDir("/repo", ".data")).toBe("/repo/.data");
    expect(resolveDataDir("/repo", "/abs/data")).toBe("/abs/data");
    expect(resolveDataDir("/repo")).toBe("/repo/.data");
  });
});
