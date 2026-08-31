import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationStore, formatRuntimeState } from "../src/conversation.js";
import { IntentStore } from "../src/intents.js";
import { parseLocalCommand, parseRangeAdjustSpeech, recoverRangeAdjustFromTurns } from "../src/localCommands.js";
import { parseLpPick } from "../src/lpPropose.js";
import { runAgentTurn } from "../src/llm.js";
import type { ToolCtx } from "../src/tools.js";
import type { LpProposal } from "../src/lpPropose.js";

const WALLET = "0xC2154520913F7F3c79c2b21164C1D6209A5ffC3C";
const CRCL_POS = {
  tokenId: "7292933",
  token0: "USDT",
  token1: "CRCLB",
  fee: 2500,
  inRange: true,
  amount0Ui: "8.21",
  amount1Ui: "0.091",
  markUsd: "16.4",
  feesUsdApprox: "0.02",
  priceLower: "67.34",
  priceUpper: "113.84",
};
const CRCL_POS_2 = { ...CRCL_POS, tokenId: "7292999", priceLower: "70.00", priceUpper: "110.00" };
const NVDA_POS = {
  tokenId: "1111111",
  token0: "USDT",
  token1: "NVDAB",
  fee: 2500,
  inRange: true,
  amount0Ui: "10",
  amount1Ui: "0.04",
  markUsd: "20",
  feesUsdApprox: "0.01",
  priceLower: "180",
  priceUpper: "260",
};

const llm = { llmBase: "", llmKey: "", llmModel: "" };

const fixtures = vi.hoisted(() => ({
  positions: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("../src/tools.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/tools.js")>();
  return {
    ...orig,
    runTool: vi.fn(async (name: string, args: string, ctx: ToolCtx) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(args || "{}") as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      fixtures.calls.push({ name, args: parsed });
      if (name === "list_positions") {
        return JSON.stringify({ positions: fixtures.positions, count: fixtures.positions.length });
      }
      if (name === "propose_lp") {
        const token = String(parsed.token ?? "CRCLB");
        const proposal = {
          kind: "lp-propose",
          token,
          balances: { token: "0.09", usdt: "8.2", bnb: "0.01" },
          options: [
            {
              n: 1,
              action: "mint",
              title: `${token}/USDT 0.25% · 用现有余额`,
              token,
              quote: "USDT",
              fee: 2500,
              feeLabel: "0.25%",
              apr24hPct: 12,
              amountTokenUi: "0.09",
              amountQuoteUi: "8.2",
              needTokenUi: "0.09",
              needQuoteUi: "8.2",
              note: "赎回后的余额可重开。",
            },
          ],
        };
        const s = ctx.conversations.get(ctx.conversation.id);
        delete s.lastLp;
        s.lastLpProposal = proposal as ToolCtx["conversation"]["lastLpProposal"];
        ctx.conversations.save(s);
        ctx.conversation = s;
        return JSON.stringify(proposal);
      }
      if (name === "create_lp_intent") {
        if (ctx.conversation.source === "termix" && ctx.conversation.hirePhase !== "working") {
          return JSON.stringify({
            error: "hire_not_ready",
            hirePhase: ctx.conversation.hirePhase ?? "none",
            message: "Termix hire is not in working yet.",
          });
        }
        return JSON.stringify({
          signerUrl: parsed.decreaseTokenId
            ? "http://127.0.0.1:3000/t/range-decrease"
            : "http://127.0.0.1:3000/t/range-mint",
          summary: parsed,
        });
      }
      if (name === "create_swap_intent") {
        return JSON.stringify({
          signerUrl: "http://127.0.0.1:3000/t/swap",
          summary: parsed,
        });
      }
      return orig.runTool(name, args, ctx);
    }),
  };
});

function makeCtx(over: Partial<ToolCtx["conversation"]> = {}): ToolCtx {
  const dir = mkdtempSync(join(tmpdir(), "range-adj-"));
  mkdirSync(join(dir, "intents"), { recursive: true });
  const conversations = new ConversationStore(dir);
  const intents = new IntentStore(join(dir, "intents"), 600_000);
  conversations.save({
    id: "t1",
    source: "local",
    geoConfirmed: true,
    userConfirmed: false,
    wallet: WALLET,
    updatedAt: new Date().toISOString(),
    ...over,
  });
  return {
    conversation: conversations.get("t1"),
    conversations,
    intents,
    signerWebUrl: "http://127.0.0.1:3000",
    dataDir: dir,
  };
}

async function say(ctx: ToolCtx, text: string): Promise<string> {
  ctx.conversation = ctx.conversations.get(ctx.conversation.id);
  const reply = await runAgentTurn(text, ctx, llm);
  ctx.conversation = ctx.conversations.get(ctx.conversation.id);
  return reply;
}

function nvdaProposal(): LpProposal {
  return {
    kind: "lp-propose",
    token: "NVDAB",
    balances: { token: "1", usdt: "8", bnb: "0.1" },
    options: [
      {
        n: 1,
        action: "mint",
        title: "NVDAB/USDT 0.25%",
        token: "NVDAB",
        quote: "USDT",
        fee: 2500,
        feeLabel: "0.25%",
        apr24hPct: 10,
        needTokenUi: "1",
        needQuoteUi: "8",
        note: "",
      },
    ],
  };
}

describe("parse range-adjust speech", () => {
  it("covers Chinese, English, and does not steal 赎回 / 组LP / 换成 USDT", () => {
    expect(parseRangeAdjustSpeech("帮我调整下CRCL的区间，变宽一点，行不行？")).toEqual({ token: "CRCLB" });
    expect(parseLocalCommand("帮我调整下CRCL的区间，变宽一点，行不行？")).toEqual({
      kind: "range-adjust",
      token: "CRCLB",
    });
    expect(parseLocalCommand("把英伟达区间调宽")).toMatchObject({ kind: "range-adjust", token: "NVDAB" });
    expect(parseLocalCommand("换个区间")).toEqual({ kind: "range-adjust" });
    expect(parseLocalCommand("widen the CRCL range a bit")).toMatchObject({
      kind: "range-adjust",
      token: "CRCLB",
    });
    expect(parseLocalCommand("adjust Circle LP range")).toMatchObject({ kind: "range-adjust", token: "CRCLB" });
    expect(parseLocalCommand("把 #7292933 区间调宽")).toEqual({
      kind: "range-adjust",
      tokenId: "7292933",
    });
    expect(parseLocalCommand("赎回")).toEqual({ kind: "decrease", fractionBps: 10_000 });
    expect(parseLocalCommand("组 LP")).toEqual({ kind: "lp", token: "" });
    expect(parseLocalCommand("换成 USDT")).toEqual({ kind: "amend-pay", tokenIn: "USDT" });
  });

  it("parses A / B / 方案B / 确认A", () => {
    expect(parseLpPick("A")).toBe(1);
    expect(parseLpPick("B")).toBe(2);
    expect(parseLpPick("方案B")).toBe(2);
    expect(parseLpPick("选B")).toBe(2);
    expect(parseLpPick("确认A")).toBe(1);
    expect(parseLpPick("3")).toBe(3);
    expect(parseLocalCommand("确认")).toEqual({ kind: "confirm" });
  });

  it("recovers NVDAB from a prose turn instead of defaulting to CRCLB", () => {
    const recovered = recoverRangeAdjustFromTurns([
      {
        role: "assistant",
        content: "仓位 #1111111（USDT/NVDAB）可以调宽。A: ±50%  B: ±100%",
      },
    ]);
    expect(recovered?.tokenId).toBe("1111111");
    expect(recovered?.token).toBe("NVDAB");
  });
});

describe("range-adjust multi-round", () => {
  beforeEach(() => {
    fixtures.positions = [{ ...CRCL_POS }];
    fixtures.calls = [];
  });

  it("keeps A then 确认 as a withdraw, not 没有待执行的报价", async () => {
    const ctx = makeCtx();
    const asked = await say(ctx, "帮我调整下CRCL的区间，变宽一点，行不行？");
    expect(asked).toMatch(/#7292933/);
    expect(asked).toMatch(/A\./);
    expect(asked).toMatch(/B\./);
    expect(ctx.conversation.lastRangeAdjust?.selected).toBeUndefined();

    const picked = await say(ctx, "A");
    expect(picked).toMatch(/方案 A/);
    expect(ctx.conversation.lastRangeAdjust?.selected).toBe(1);
    expect(ctx.conversation.lastLp).toMatchObject({
      token: "CRCLB",
      decreaseTokenId: "7292933",
      decreaseBps: 10_000,
    });

    const confirmed = await say(ctx, "确认");
    expect(confirmed).not.toMatch(/没有待执行的报价/);
    expect(confirmed).toContain("http://127.0.0.1:3000/t/range-decrease");
    expect(fixtures.calls.filter((c) => c.name === "create_lp_intent").at(-1)?.args).toMatchObject({
      decreaseTokenId: "7292933",
      decreaseBps: 10_000,
    });
  });

  it("switches A to B before confirm and widens to ±100%", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    const picked = await say(ctx, "B");
    expect(picked).toMatch(/方案 B/);
    expect(picked).toMatch(/±100%/);
    expect(ctx.conversation.lastRangeAdjust?.selected).toBe(2);
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBe("7292933");
  });

  it("executes 确认A in one turn", async () => {
    const ctx = makeCtx();
    await say(ctx, "把 CRCL 区间调宽");
    const reply = await say(ctx, "确认A");
    expect(reply).toContain("/t/range-decrease");
    expect(ctx.conversation.lastRangeAdjust?.selected).toBe(1);
  });

  it("rejects 3 / C when only A/B exist", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    const three = await say(ctx, "3");
    expect(three).toMatch(/没有方案 3|回复 A \/ B/);
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBeUndefined();
    const c = await say(ctx, "C");
    expect(c).toMatch(/没有方案 3|回复 A \/ B/);
  });

  it("does not treat a bare 确认 as withdraw before A/B is picked", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    const early = await say(ctx, "确认");
    expect(early).toMatch(/A \/ B|回复 A/);
    expect(early).not.toContain("/t/range-decrease");
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBeUndefined();
  });

  it("cancels a picked range so a later 确认 is empty", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    const cancelled = await say(ctx, "取消");
    expect(cancelled).toMatch(/Cancelled|取消/i);
    expect(ctx.conversation.lastRangeAdjust).toBeUndefined();
    expect(ctx.conversation.lastLp).toBeUndefined();
    const again = await say(ctx, "确认");
    expect(again).toMatch(/没有待执行的报价/);
  });

  it("does not execute a leftover swap quote after 调整区间", async () => {
    const ctx = makeCtx({
      lastQuote: { tokenIn: "USDT", tokenOut: "NVDAB", amountInUi: "10" },
    });
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    expect(ctx.conversation.lastQuote).toBeUndefined();
    const early = await say(ctx, "确认");
    expect(early).not.toContain("/t/swap");
    expect(early).toMatch(/A \/ B|回复 A/);
  });

  it("asks for an NFT id when two CRCL positions exist", async () => {
    fixtures.positions = [{ ...CRCL_POS }, { ...CRCL_POS_2 }];
    const ctx = makeCtx();
    const reply = await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    expect(reply).toMatch(/2 个 CRCLB 仓位|NFT 编号/);
    expect(ctx.conversation.lastRangeAdjust).toBeUndefined();
  });

  it("uses the spoken NFT id when two CRCL positions exist", async () => {
    fixtures.positions = [{ ...CRCL_POS }, { ...CRCL_POS_2 }];
    const ctx = makeCtx();
    const reply = await say(ctx, "把 #7292933 区间调宽");
    expect(reply).toMatch(/#7292933/);
    expect(reply).not.toMatch(/2 个 CRCLB 仓位/);
    expect(ctx.conversation.lastRangeAdjust?.tokenId).toBe("7292933");
  });

  it("errors when the named token has no position", async () => {
    const ctx = makeCtx();
    const reply = await say(ctx, "把英伟达区间调宽");
    expect(reply).toMatch(/没有 NVDAB/);
    expect(ctx.conversation.lastRangeAdjust).toBeUndefined();
  });

  it("does not create a signer when geo is not confirmed", async () => {
    const ctx = makeCtx({ geoConfirmed: false });
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    const reply = await say(ctx, "确认");
    expect(reply).toMatch(/美国|restricted region/i);
    expect(reply).not.toContain("/t/range-decrease");
  });

  it("blocks DeFi while Termix hire is only offered", async () => {
    const ctx = makeCtx({ source: "termix", hirePhase: "offered" });
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    const reply = await say(ctx, "确认");
    expect(reply).toMatch(/not in working|hire_not_ready|checkout/i);
    expect(reply).not.toContain("/t/range-decrease");
  });

  it("recovers A/B from an LLM prose turn so 确认 still works", async () => {
    const ctx = makeCtx();
    ctx.conversations.appendTurn(ctx.conversation.id, "user", "帮我调整下CRCL的区间，变宽一点，行不行？");
    ctx.conversations.appendTurn(
      ctx.conversation.id,
      "assistant",
      [
        "可以。仓位 #7292933（USDT/CRCLB 0.25%）现在大约 67.34 – 113.84。",
        "A: ±50%（5000 bps）  B: ±100%（10000 bps）",
        "回复 A 或 B。选完后回复「确认」出第一步赎回签名页。",
      ].join("\n"),
    );
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);
    expect(recoverRangeAdjustFromTurns(ctx.conversation.turns)?.tokenId).toBe("7292933");

    const picked = await say(ctx, "A");
    expect(picked).toMatch(/方案 A/);
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBe("7292933");

    const confirmed = await say(ctx, "确认");
    expect(confirmed).not.toMatch(/没有待执行的报价/);
    expect(confirmed).toContain("/t/range-decrease");
  });

  it("does not let a leftover range-adjust steal 组LP option 1", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    await say(ctx, "确认");
    ctx.conversation.lastLpProposal = nvdaProposal();
    ctx.conversations.save(ctx.conversation);

    const picked = await say(ctx, "1");
    expect(picked).toMatch(/方案 1|NVDAB/);
    expect(ctx.conversation.lastLp).toMatchObject({ token: "NVDAB" });
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBeUndefined();
  });

  it("after withdraw settles, 继续 remints with the chosen wider range", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    await say(ctx, "确认");
    ctx.conversations.markSettled(ctx.conversation.id, {
      kind: "lp-decrease",
      intentId: "dec-1",
      at: new Date().toISOString(),
      txHashes: ["0xabc"],
      pair: "CRCLB/USDT",
      tokenId: "7292933",
      message: "已赎回 NFT #7292933。",
    });
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);

    const cont = await say(ctx, "继续");
    expect(cont).not.toMatch(/没有待执行的报价/);
    const mint = fixtures.calls.find((c) => c.name === "propose_lp") ?? fixtures.calls.find((c) => c.name === "create_lp_intent" && !c.args.decreaseTokenId);
    expect(mint).toBeTruthy();
    expect(ctx.conversation.lastLp?.rangeBps === 5000 || mint?.args.rangeBps === 5000 || /±50%|5000/.test(cont)).toBe(
      true,
    );
  });

  it("after withdraw settles, 确认 also remints instead of 没有待执行的报价", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    await say(ctx, "确认");
    ctx.conversations.markSettled(ctx.conversation.id, {
      kind: "lp-decrease",
      intentId: "dec-2",
      at: new Date().toISOString(),
      txHashes: ["0xdef"],
      pair: "CRCLB/USDT",
      tokenId: "7292933",
      message: "已赎回 NFT #7292933。",
    });
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);
    fixtures.calls = [];

    const again = await say(ctx, "确认");
    expect(again).not.toMatch(/没有待执行的报价/);
    expect(fixtures.calls.find((c) => c.name === "propose_lp")?.args).toMatchObject({
      token: "CRCLB",
      rangeBps: 5000,
    });
    expect(ctx.conversation.lastLpProposal?.token).toBe("CRCLB");
  });

  it("keeps the wider range when remint option 1 is picked", async () => {
    const ctx = makeCtx();
    await say(ctx, "帮我调整下CRCL的区间，变宽一点");
    await say(ctx, "A");
    await say(ctx, "确认");
    ctx.conversations.markSettled(ctx.conversation.id, {
      kind: "lp-decrease",
      intentId: "dec-3",
      at: new Date().toISOString(),
      txHashes: ["0xaaa"],
      pair: "CRCLB/USDT",
      tokenId: "7292933",
      message: "已赎回 NFT #7292933。",
    });
    ctx.conversation = ctx.conversations.get(ctx.conversation.id);
    await say(ctx, "继续");
    const picked = await say(ctx, "1");
    expect(picked).toMatch(/方案 1|CRCLB/);
    expect(ctx.conversation.lastLp?.rangeBps).toBe(5000);
    expect(ctx.conversation.lastLp?.decreaseTokenId).toBeUndefined();
  });

  it("tells the model a selected range-adjust must withdraw on confirm", () => {
    const text = formatRuntimeState({
      id: "local",
      geoConfirmed: true,
      userConfirmed: false,
      lastRangeAdjust: {
        kind: "range-adjust",
        tokenId: "7292933",
        token: "CRCLB",
        quote: "USDT",
        selected: 1,
        options: [
          { n: 1, letter: "A", rangeBps: 5000, title: "±50%" },
          { n: 2, letter: "B", rangeBps: 10000, title: "±100%" },
        ],
      },
      lastLp: { token: "CRCLB", decreaseTokenId: "7292933", decreaseBps: 10_000 },
      updatedAt: new Date().toISOString(),
    });
    expect(text).toMatch(/User picked range A/);
    expect(text).toMatch(/do not say there is no pending quote/i);
  });

  it("still reports no pending quote when nothing is parked", async () => {
    const ctx = makeCtx();
    const reply = await say(ctx, "确认");
    expect(reply).toMatch(/没有待执行的报价/);
  });
});
