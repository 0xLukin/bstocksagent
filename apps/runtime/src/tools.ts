import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  analyzeLp,
  assertPositionOwner,
  compareLpPools,
  buildCollectTx,
  buildDecreaseLpTxs,
  buildIncreaseLpTxs,
  buildMintLpTxs,
  buildSwapTxs,
  DEFAULT_LP_RANGE_BPS,
  executionQuotePerUnit,
  getPublicClient,
  getToken,
  isWhitelisted,
  listPositions,
  parseUiNumber,
  priceDeviationBps,
  quoteSwap,
  readBalanceUi,
  readPosition,
  resolveSpokenBstock,
  simulatePreparedTxs,
  swapAssetSymbol,
  swapNotionalUsd,
  wantsNativeBnb,
  type PreparedTx,
} from "@bstocks/chain";
import { evaluateRisk, loadRiskConfig } from "@bstocks/risk";
import { TermixClient } from "@bstocks/termix";
import { buildDeliveryReport, renderMarkdown } from "@bstocks/report";
import {
  canCreateDefiIntent,
  isFundingSwapForLp,
  latchSwapThenLpPlan,
  parkedMint,
  parseParkedLp,
  type ConversationState,
  type ConversationStore,
  type PendingQuote,
} from "./conversation.js";
import {
  acceptFundedOrder,
  refreshHireFromTermix,
  sendStandardOffer,
  serviceFeeLabel,
  submitHireDelivery,
} from "./hire.js";
import { type IntentStore, type StoredIntent } from "./intents.js";
import { buildLpProposal, fundOptionForSwap, pendingLpFromOption } from "./lpPropose.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type ToolCtx = {
  conversation: ConversationState;
  conversations: ConversationStore;
  intents: IntentStore;
  signerWebUrl: string;
  client?: PublicClient;
  termix?: TermixClient;
  agentId?: string;
  dataDir: string;
};

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "get_bstock_price",
      description:
        "Mid price: how many quote units for 1 share of a whitelist bStock (e.g. 1 NVDAB ≈ X USDT). Not a 1 USDT buy quote. token accepts aliases (NVDAB, NVDA, 英伟达).",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "NVDAB or alias such as NVDA / bNVDA / 英伟达" },
          quote: { type: "string" },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quote_swap",
      description: "Quote a whitelist V3 swap for the user's amount. Amount is UI display units.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: { type: "string" },
          tokenOut: { type: "string" },
          amountInUi: { type: "string" },
          fee: { type: "number" },
        },
        required: ["tokenIn", "tokenOut", "amountInUi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_lp_pools",
      description: "List whitelist V3 pools for a bStock (USDT/USDC/WBNB) with Pancake Explorer 24h fee APR, TVL, and volume. Use for highest APR / 最高apr. Does not create an intent.",
      parameters: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_lp",
      description:
        "When the user wants to add LP: read wallet balances, list viable V3 pools, and return numbered options (mint with current balances vs fund with a BNB→USDT swap vs cannot). Do not create a signer page. Wait for them to pick a number.",
      parameters: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_lp",
      description: "Read Pancake V3 pool state, real TVL, mid price, and a suggested ±30% range.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string" },
          quote: { type: "string" },
          fee: { type: "number" },
          rangeBps: { type: "number" },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_positions",
      description: "List the bound wallet's Pancake V3 positions on whitelist bStock pools.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_balance",
      description: "Read a whitelist token balance for the bound wallet (or a given 0x).",
      parameters: {
        type: "object",
        properties: { token: { type: "string" }, account: { type: "string" } },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_swap_intent",
      description:
        "Create a user-signed swap intent from the pending quote. Requires geo + explicit confirm. If lastQuote exists, call this immediately on confirm / 确认 — do not re-ask the pair or amount.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: { type: "string" },
          tokenOut: { type: "string" },
          amountInUi: { type: "string" },
          slippageBps: { type: "number" },
          fee: { type: "number" },
        },
        required: ["tokenIn", "tokenOut", "amountInUi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_swap_then_lp",
      description:
        "When they want to mint LP but the quote asset (USDT/USDC) is short and they have BNB (or another whitelist asset), quote a funding swap AND park the LP mint as step 2. Next confirm opens the swap signer page; the confirm after that swap opens the LP signer page. Do not tell them to leave and deposit from a CEX if this path works.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: { type: "string", description: "Funding asset, usually BNB" },
          tokenOut: { type: "string", description: "The LP quote asset they are short of, usually USDT" },
          amountInUi: { type: "string", description: "How much tokenIn to swap. Cover the shortfall plus ~5-10% buffer, leave BNB for gas." },
          lpToken: { type: "string", description: "bStock to mint, e.g. NVDAB" },
          lpQuote: { type: "string", description: "Pool quote asset, e.g. USDT" },
          lpFee: { type: "number", description: "Pool fee tier, e.g. 10000 for 1%" },
          budgetQuoteUi: { type: "string", description: "Total LP budget in quote units after the swap" },
        },
        required: ["tokenIn", "tokenOut", "amountInUi", "lpToken", "lpQuote", "budgetQuoteUi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_lp_intent",
      description:
        "Create a user-signed LP intent: mint (default range ±30%), collect, increase, or decrease. Requires geo + confirm.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string" },
          quote: { type: "string", description: "USDT, USDC, or WBNB. Required when the user picked a compared pool." },
          amountTokenUi: { type: "string" },
          amountQuoteUi: { type: "string" },
          budgetQuoteUi: { type: "string", description: "Total USDT budget to deploy (split by V3 math, not 50/50)." },
          rangeBps: { type: "number", description: "Default 3000 = ±30%. 1500 = ±15%. 1000 = ±10%." },
          fee: { type: "number" },
          collectTokenId: { type: "string" },
          increaseTokenId: { type: "string" },
          decreaseTokenId: { type: "string" },
          decreaseBps: { type: "number", description: "10000 = full exit, 5000 = half." },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_tx",
      description: "Verify a broadcast tx hash on BSC.",
      parameters: {
        type: "object",
        properties: { txHash: { type: "string" } },
        required: ["txHash"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_report",
      description: "Build a delivery markdown/json report with live positions when possible.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
          txs: {
            type: "array",
            items: {
              type: "object",
              properties: { kind: { type: "string" }, hash: { type: "string" }, note: { type: "string" } },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_termix_offer",
      description: `Send the listing Standard offer (${serviceFeeLabel()} escrow) in this Termix conversation. Use after geo when the buyer asks for the standard quote. Do not use this for DeFi size.`,
      parameters: {
        type: "object",
        properties: {
          price: { type: "string" },
          scope: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "provider_accept_order",
      description:
        "Seller-side: accept a funded Termix order on-chain. Call immediately when hirePhase is funded. Uses the agent wallet, not the buyer.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_termix_delivery",
      description:
        "Upload the written report and submitDelivery on-chain. Call when hirePhase is working and the buyer asked to deliver, or after the DeFi tx is verified.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          notes: { type: "string" },
          confirmEmpty: {
            type: "boolean",
            description: "Set true only after the buyer explicitly accepts a report with no DeFi hash.",
          },
        },
      },
    },
  },
] as const;

export function serializeToolResult(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function rememberCreatedIntent(
  ctx: ToolCtx,
  intent: { id: string; kind: string; signerUrl: string; summary?: Record<string, unknown> },
) {
  ctx.conversations.rememberIntent(ctx.conversation.id, intent);
  ctx.conversation.lastIntent = ctx.conversations.get(ctx.conversation.id).lastIntent;
}

function gate(state: ConversationState) {
  if (!state.geoConfirmed) {
    throw new Error("Geo not confirmed. Ask the user to declare they are not in the US or a restricted region.");
  }
  if (!state.userConfirmed) {
    throw new Error("User has not confirmed. Show the plan, then wait for confirm / 确认执行.");
  }
  if (!state.wallet) {
    throw new Error("No user wallet yet. Ask for a 0x address.");
  }
}

const MIN_GAS_BNB = 0.0008;

async function gasWarning(wallet: Address): Promise<string | undefined> {
  try {
    const wei = await getPublicClient().getBalance({ address: wallet });
    const bnb = Number(formatEther(wei));
    if (!Number.isFinite(bnb)) return undefined;
    if (bnb < MIN_GAS_BNB) {
      return `BNB on the bound wallet is ${bnb} — likely not enough gas to broadcast. Fund BNB on BSC before signing.`;
    }
    if (bnb < 0.002) {
      return `BNB on the bound wallet is ${bnb} (low). Checkout/sign may fail if gas spikes.`;
    }
  } catch {
    /* quote still useful */
  }
  return undefined;
}

async function withGasWarning(wallet: Address | undefined, payload: Record<string, unknown>) {
  const gas = wallet ? await gasWarning(wallet) : undefined;
  return serializeToolResult({ ...payload, ...(gas ? { gasWarning: gas } : {}) });
}

function gateDefiHire(state: ConversationState) {
  if (!canCreateDefiIntent(state)) {
    return serializeToolResult({
      error: "hire_not_ready",
      hirePhase: state.hirePhase ?? "none",
      message:
        `Termix hire is not in working yet. Accept the ${serviceFeeLabel()} offer and finish checkout first. The signer page comes after I accept the order.`,
    });
  }
  return null;
}

function riskFor(args: {
  tokenIn: string;
  tokenOut?: string;
  slippageBps: number;
  notionalUsd: number;
  poolLiquidityUsd: number;
  priceDeviationBps: number;
  amountMin: bigint;
  state: ConversationState;
}) {
  return evaluateRisk({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    whitelistOk: isWhitelisted(args.tokenIn) && (!args.tokenOut || isWhitelisted(args.tokenOut)),
    slippageBps: args.slippageBps,
    notionalUsd: args.notionalUsd,
    poolLiquidityUsd: args.poolLiquidityUsd,
    priceDeviationBps: args.priceDeviationBps,
    amountMin: args.amountMin,
    geoConfirmed: args.state.geoConfirmed,
    userConfirmed: args.state.userConfirmed,
  });
}

function consumePending(ctx: ToolCtx) {
  ctx.conversations.consumeConfirm(ctx.conversation.id);
  ctx.conversations.clearPending(ctx.conversation.id);
  delete ctx.conversation.lastQuote;
  delete ctx.conversation.lastLp;
  delete ctx.conversation.pendingPlan;
  delete ctx.conversation.lastLpProposal;
  ctx.conversation.userConfirmed = false;
}

function afterCreateSwapIntent(ctx: ToolCtx, intentId: string) {
  const s = ctx.conversations.get(ctx.conversation.id);
  const created = ctx.intents.get(intentId);
  const swapFromIntent: PendingQuote | undefined = created
    ? {
        tokenIn: String(created.summary.tokenIn ?? s.lastQuote?.tokenIn ?? ""),
        tokenOut: String(created.summary.tokenOut ?? s.lastQuote?.tokenOut ?? ""),
        amountInUi: String(created.summary.amountInUi ?? s.lastQuote?.amountInUi ?? ""),
      }
    : s.lastQuote;
  if (!parkedMint(s.lastLp)) {
    const fromSummary = parseParkedLp(created?.summary?.parkedLp);
    const fromOption = fundOptionForSwap(s.lastLpProposal, swapFromIntent);
    const lp = fromSummary ?? (fromOption ? pendingLpFromOption(fromOption) : undefined);
    if (parkedMint(lp)) s.lastLp = { ...lp!, committed: true };
  }
  if (s.pendingPlan?.kind === "swap_then_lp" && s.pendingPlan.phase !== "lp") {
    s.pendingPlan = { ...s.pendingPlan, swapIntentId: intentId, phase: "swap" };
    s.userConfirmed = false;
    ctx.conversations.save(s);
    ctx.conversation.pendingPlan = s.pendingPlan;
    ctx.conversation.lastQuote = s.lastQuote;
    ctx.conversation.lastLp = s.lastLp;
    ctx.conversation.userConfirmed = false;
    return;
  }
  if (parkedMint(s.lastLp) && isFundingSwapForLp(swapFromIntent, s.lastLp) && swapFromIntent) {
    latchSwapThenLpPlan(s, swapFromIntent, s.lastLp!);
    s.pendingPlan = { ...s.pendingPlan!, swapIntentId: intentId, phase: "swap" };
    s.userConfirmed = false;
    ctx.conversations.save(s);
    ctx.conversation.pendingPlan = s.pendingPlan;
    ctx.conversation.lastQuote = s.lastQuote;
    ctx.conversation.lastLp = s.lastLp;
    ctx.conversation.userConfirmed = false;
    return;
  }
  consumePending(ctx);
}

export function intentFilled(intent: { txs: unknown[]; txHashes: unknown[] } | undefined): boolean {
  if (!intent) return false;
  return intent.txs.length > 0 && intent.txHashes.length >= intent.txs.length;
}

export function lpSignerIsReusable(intent: StoredIntent | undefined): boolean {
  if (!intent || intent.cancelledAt) return false;
  if (!intent.kind.startsWith("lp")) return false;
  if (intent.txHashes.length > 0) return false;
  if (intent.simulation?.ok === false) return false;
  return true;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function latchUserConfirmed(ctx: ToolCtx) {
  const s = ctx.conversations.get(ctx.conversation.id);
  s.userConfirmed = true;
  ctx.conversations.save(s);
  ctx.conversation.userConfirmed = true;
}

export type ContinuePlanResult = {
  signerUrl?: string;
  intentId?: string;
  expiresAt?: string;
  summary?: Record<string, unknown>;
  error?: string;
  message?: string;
  note?: string;
};

const continueInflight = new Map<string, Promise<ContinuePlanResult>>();

function resolvePlanSwapIntent(ctx: ToolCtx, known?: StoredIntent): StoredIntent | undefined {
  const s = ctx.conversations.get(ctx.conversation.id);
  ctx.conversation = s;
  if (known?.kind === "swap") return known;
  const plan = s.pendingPlan;
  if (plan?.kind !== "swap_then_lp") return known;
  if (plan.swapIntentId) return ctx.intents.get(plan.swapIntentId);
  if (s.lastIntent?.kind === "swap" && !s.lastIntent.cancelled) {
    const intent = ctx.intents.get(s.lastIntent.id);
    if (
      intent &&
      !intent.cancelledAt &&
      String(intent.summary.amountInUi) === plan.swap.amountInUi &&
      String(intent.summary.tokenIn) === plan.swap.tokenIn
    ) {
      return intent;
    }
  }
  return undefined;
}

function synthesizeSwapThenLp(s: ConversationState, known?: StoredIntent): boolean {
  if (s.pendingPlan?.kind === "swap_then_lp") return true;
  const summary =
    known?.kind === "swap" ? known.summary : s.lastIntent?.kind === "swap" ? s.lastIntent.summary : undefined;
  let lp = s.lastLp;
  if (!parkedMint(lp)) {
    lp = parseParkedLp(summary?.parkedLp);
    if (parkedMint(lp)) s.lastLp = lp;
  }
  if (!parkedMint(lp)) return false;
  const swapIntentId =
    known?.kind === "swap"
      ? known.id
      : s.lastIntent?.kind === "swap" && !s.lastIntent.cancelled
        ? s.lastIntent.id
        : undefined;
  const swap: PendingQuote | undefined = s.lastQuote
    ?? (summary
      ? {
          tokenIn: String(summary.tokenIn ?? "BNB"),
          tokenOut: String(summary.tokenOut ?? lp!.quote ?? "USDT"),
          amountInUi: String(summary.amountInUi ?? ""),
        }
      : undefined);
  if (!swap || !isFundingSwapForLp(swap, lp)) return false;
  s.pendingPlan = {
    kind: "swap_then_lp",
    phase: "swap",
    swap,
    lp: lp!,
    swapIntentId,
  };
  return true;
}

async function continueSwapThenLpInner(ctx: ToolCtx, known?: StoredIntent, recordTurn = false): Promise<ContinuePlanResult> {
  const s = ctx.conversations.get(ctx.conversation.id);
  ctx.conversation = s;
  if (!synthesizeSwapThenLp(s, known)) {
    return { error: "no_plan", message: "没有进行中的两步计划。可以说「取消」后重新下单。" };
  }
  ctx.conversations.save(s);
  ctx.conversation.pendingPlan = s.pendingPlan;
  const plan = s.pendingPlan!;

  if (s.lastIntent?.kind?.startsWith("lp") && s.lastIntent.signerUrl && !s.lastIntent.cancelled) {
    const existing = ctx.intents.get(s.lastIntent.id);
    if (existing && intentFilled(existing)) {
      const note =
        s.lastSettled?.intentId === existing.id
          ? s.lastSettled.message
          : (await maybeSettleLpAfterTx(ctx, existing)).settledNote;
      return { note: note ?? "LP already on-chain", message: note };
    }
    if (lpSignerIsReusable(existing)) {
      return {
        intentId: s.lastIntent.id,
        signerUrl: s.lastIntent.signerUrl,
        summary: s.lastIntent.summary,
        note: "第二步 LP 签名页已就绪",
      };
    }
    try {
      if (existing && existing.txHashes.length === 0 && !existing.cancelledAt) {
        ctx.intents.cancel(s.lastIntent.id);
      }
    } catch {
      /* already cancelled */
    }
    s.lastIntent = { ...s.lastIntent, cancelled: true };
    ctx.conversations.save(s);
    ctx.conversation.lastIntent = s.lastIntent;
  }

  const swapIntent = resolvePlanSwapIntent(ctx, known);
  if (!swapIntent || swapIntent.cancelledAt) {
    return { error: "no_swap_intent", message: "第一步签名页还没生成。请先回复「确认」。" };
  }

  if (!intentFilled(swapIntent)) {
    return {
      intentId: swapIntent.id,
      signerUrl: signerOf(ctx, swapIntent),
      expiresAt: swapIntent.expiresAt,
      summary: swapIntent.summary,
      note: "第一步还没签完。请打开同一链接完成兑换；签完后会自动出 LP 页，或回来说「继续」。",
    };
  }

  if (plan.phase !== "lp") {
    const next = ctx.conversations.advanceSwapThenLpAfterSwap(ctx.conversation.id);
    Object.assign(ctx.conversation, next);
  }

  const client = ctx.client ?? getPublicClient();
  const lastHash = swapIntent.txHashes.at(-1);
  if (lastHash) {
    try {
      await client.waitForTransactionReceipt({ hash: lastHash, timeout: 90_000 });
    } catch {
      /* RPC lag: mint may still fail; 继续 retries */
    }
  }

  const lp = ctx.conversation.lastLp ?? plan.lp;
  if (!lp) return { error: "no_lp", message: "两步计划里没有组 LP 的参数。" };

  let lastErr = "组 LP 失败";
  for (let i = 0; i < 4; i++) {
    if (i > 0) await sleep(2500);
    latchUserConfirmed(ctx);
    try {
      const raw = await runTool(
        "create_lp_intent",
        JSON.stringify({
          token: lp.token,
          quote: lp.quote,
          fee: lp.fee,
          budgetQuoteUi: lp.budgetQuoteUi,
          amountTokenUi: lp.amountTokenUi,
          amountQuoteUi: lp.amountQuoteUi,
          rangeBps: lp.rangeBps,
        }),
        ctx,
      );
      const parsed = JSON.parse(raw) as ContinuePlanResult;
      if (parsed.signerUrl) {
        ctx.intents.patch(swapIntent.id, { followUpSignerUrl: parsed.signerUrl });
        if (recordTurn) {
          ctx.conversations.appendTurn(ctx.conversation.id, "assistant", formatFollowUpLpReply(parsed));
        }
        return parsed;
      }
      lastErr = parsed.message ?? parsed.error ?? raw;
      if (
        parsed.error === "risk_blocked" ||
        parsed.error === "hire_not_ready" ||
        parsed.error === "insufficient_balance" ||
        parsed.error === "sim_failed"
      ) {
        return parsed;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  const message = `第一步已上链，但组 LP 还没成功（常见原因：RPC 余额还没更新）。稍等几秒再说「继续」。${lastErr}`;
  ctx.intents.patch(swapIntent.id, { followUpError: message });
  return { error: "lp_failed", message };
}

export async function continueSwapThenLp(ctx: ToolCtx, known?: StoredIntent, recordTurn = false): Promise<ContinuePlanResult> {
  const id = ctx.conversation.id;
  const existing = continueInflight.get(id);
  if (existing) return existing;
  const pending = continueSwapThenLpInner(ctx, known, recordTurn).finally(() => {
    continueInflight.delete(id);
  });
  continueInflight.set(id, pending);
  return pending;
}

/** After an LP intent is fully signed, remember the on-chain position in conversation memory. */
export async function maybeSettleLpAfterTx(
  ctx: ToolCtx,
  intent: StoredIntent,
): Promise<{ settledNote?: string }> {
  if (!intent.kind.startsWith("lp") || !intentFilled(intent)) return {};
  const s = ctx.conversations.get(intent.conversationId ?? ctx.conversation.id);
  ctx.conversation = s;
  if (s.lastSettled?.intentId === intent.id) {
    return { settledNote: s.lastSettled.message };
  }
  const client = ctx.client ?? getPublicClient();
  const lastHash = intent.txHashes.at(-1);
  if (lastHash) {
    try {
      await client.waitForTransactionReceipt({ hash: lastHash, timeout: 90_000 });
    } catch {
      /* still try to read positions */
    }
  }
  let tokenId: string | undefined;
  let pair: string | undefined;
  const summaryPair =
    intent.summary.token0 && intent.summary.token1
      ? `${String(intent.summary.token0)}/${String(intent.summary.token1)}`
      : undefined;
  const summaryId = intent.summary.tokenId != null ? String(intent.summary.tokenId) : undefined;

  if (intent.kind === "lp-decrease") {
    const burned = Boolean(intent.summary.burn) || Number(intent.summary.decreaseBps ?? 0) >= 10_000;
    pair = summaryPair;
    tokenId = burned ? undefined : summaryId;
    const who = summaryId ? `NFT #${summaryId}` : "该仓位";
    const message = burned
      ? `仓位已退出。${who}${pair ? `（${pair}）` : ""} 的流动性已回到钱包。不是投资建议。可以说「我的仓位」查看。`
      : `已减仓。${who} 还在。不是投资建议。可以说「我的仓位」查看。`;
    const settled = {
      kind: intent.kind,
      intentId: intent.id,
      at: new Date().toISOString(),
      txHashes: [...intent.txHashes],
      pair,
      tokenId,
      message,
    };
    ctx.conversations.markSettled(s.id, settled);
    ctx.conversations.appendTurn(s.id, "assistant", message);
    ctx.conversation = ctx.conversations.get(s.id);
    ctx.intents.patch(intent.id, { settledNote: message });
    return { settledNote: message };
  }

  if (intent.kind === "lp-collect") {
    tokenId = summaryId;
    pair = summaryPair;
    const message = `手续费已领取。${tokenId ? `NFT #${tokenId} 本金还在。` : ""}不是投资建议。可以说「我的仓位」查看。`;
    const settled = {
      kind: intent.kind,
      intentId: intent.id,
      at: new Date().toISOString(),
      txHashes: [...intent.txHashes],
      pair,
      tokenId,
      message,
    };
    ctx.conversations.markSettled(s.id, settled);
    ctx.conversations.appendTurn(s.id, "assistant", message);
    ctx.conversation = ctx.conversations.get(s.id);
    ctx.intents.patch(intent.id, { settledNote: message });
    return { settledNote: message };
  }

  if (s.wallet) {
    const want0 = String(intent.summary.token0 ?? "");
    const want1 = String(intent.summary.token1 ?? "");
    for (let i = 0; i < 4; i++) {
      if (i > 0) await sleep(2500);
      try {
        const positions = await listPositions(s.wallet, client);
        const hit =
          positions.find(
            (p) =>
              (p.token0 === want0 && p.token1 === want1) || (p.token0 === want1 && p.token1 === want0),
          ) ?? [...positions].sort((a, b) => Number(b.tokenId) - Number(a.tokenId))[0];
        if (hit) {
          tokenId = hit.tokenId;
          pair = `${hit.token0}/${hit.token1}`;
          break;
        }
      } catch {
        /* RPC lag */
      }
    }
  }
  const message = tokenId
    ? `LP 已上链。仓位 NFT #${tokenId}${pair ? `（${pair}）` : ""}。不是投资建议。可以说「我的仓位」查看。`
    : `LP 交易已广播${lastHash ? `（${lastHash}）` : ""}。仓位列表可能还在刷新，稍后可以说「我的仓位」。`;
  const settled = {
    kind: intent.kind,
    intentId: intent.id,
    at: new Date().toISOString(),
    txHashes: [...intent.txHashes],
    pair,
    tokenId,
    message,
  };
  ctx.conversations.markSettled(s.id, settled);
  ctx.conversations.appendTurn(s.id, "assistant", message);
  ctx.conversation = ctx.conversations.get(s.id);
  ctx.intents.patch(intent.id, { settledNote: message });
  return { settledNote: message };
}

export async function maybeContinueSwapThenLpAfterTx(
  ctx: ToolCtx,
  intent: StoredIntent,
): Promise<{ nextSignerUrl?: string; nextError?: string }> {
  const s = ctx.conversations.get(ctx.conversation.id);
  ctx.conversation = s;
  if (intent.kind !== "swap" || !intentFilled(intent)) return {};
  synthesizeSwapThenLp(s, intent);
  ctx.conversations.save(s);
  ctx.conversation = s;
  const plan = s.pendingPlan;
  if (plan?.kind !== "swap_then_lp") return {};
  if (plan.swapIntentId && plan.swapIntentId !== intent.id) return {};

  const result = await continueSwapThenLp(ctx, intent, true);
  if (result.signerUrl) return { nextSignerUrl: result.signerUrl };
  if (result.error && result.error !== "no_plan") return { nextError: result.message ?? result.error };
  return {};
}

function formatFollowUpLpReply(data: ContinuePlanResult): string {
  const s = data.summary ?? {};
  const pair = s.token0 && s.token1 ? `LP ${s.token0}/${s.token1}` : "";
  return [
    "第一步兑换已上链。第二步 LP 签名页已生成（不是投资建议）。",
    pair,
    data.signerUrl ? `签名链接：${data.signerUrl}` : "",
    "请用绑定的钱包打开。核对地址、数量和 raw。",
  ]
    .filter(Boolean)
    .join("\n");
}

function signerOf(ctx: ToolCtx, intent: { id: string }) {
  return `${ctx.signerWebUrl}/t/${intent.id}`;
}

async function intentSimulation(client: PublicClient, account: Address, txs: PreparedTx[]) {
  try {
    const sim = await simulatePreparedTxs(client, account, txs);
    const gas = sim.gasFeeWei > 0n ? `Estimated miner fee ~ ${formatEther(sim.gasFeeWei)} BNB` : undefined;
    return {
      ok: !sim.hardFail,
      notes: [...sim.notes, gas].filter((x): x is string => Boolean(x)),
    };
  } catch (err) {
    return {
      ok: true,
      notes: [`Runtime simulation incomplete: ${err instanceof Error ? err.message : String(err)}. The signer page will simulate again.`],
    };
  }
}

async function midQuotePerShare(token: string, quote: string, client: PublicClient): Promise<number> {
  const q = await quoteSwap({ tokenIn: token, tokenOut: quote, amountInUi: "1", client });
  return parseUiNumber(q.amountOutUi);
}

export async function runTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const client = ctx.client ?? getPublicClient();

  if (name === "get_bstock_price") {
    const token = resolveSpokenBstock(String(args.token)).symbol;
    const quote = getToken(String(args.quote ?? "USDT")).symbol;
    const q = await quoteSwap({ tokenIn: token, tokenOut: quote, amountInUi: "1", client });
    return serializeToolResult({
      token,
      requested: String(args.token),
      quote,
      uiPrice: q.amountOutUi,
      display: `${token} ≈ ${q.amountOutUi} ${quote} / share`,
      rawOut: q.amountOutRaw.toString(),
      fee: q.fee,
      pool: q.pool,
      route: q.route,
    });
  }

  if (name === "quote_swap") {
    const q = await quoteSwap({
      tokenIn: String(args.tokenIn),
      tokenOut: String(args.tokenOut),
      amountInUi: String(args.amountInUi),
      fee: args.fee != null ? Number(args.fee) : undefined,
      minPoolTvlUsd: loadRiskConfig().minPoolLiquidityUsd,
      client,
    });
    const swap = {
      tokenIn: q.nativeIn ? "BNB" : q.tokenIn.symbol,
      tokenOut: q.nativeOut ? "BNB" : q.tokenOut.symbol,
      amountInUi: q.amountInUi,
    };
    if (ctx.conversation.pendingPlan?.kind === "swap_then_lp") {
      if (ctx.conversation.pendingPlan.phase === "swap" && !ctx.conversation.pendingPlan.swapIntentId) {
        latchSwapThenLpPlan(ctx.conversation, swap, ctx.conversation.pendingPlan.lp);
      }
    } else if (parkedMint(ctx.conversation.lastLp) && isFundingSwapForLp(swap, ctx.conversation.lastLp)) {
      latchSwapThenLpPlan(ctx.conversation, swap, ctx.conversation.lastLp!);
    } else {
      ctx.conversation.lastQuote = swap;
      delete ctx.conversation.lastLp;
    }
    ctx.conversations.save(ctx.conversation);
    return serializeToolResult({
      ...q,
      amountInRaw: q.amountInRaw.toString(),
      amountOutRaw: q.amountOutRaw.toString(),
      sqrtPriceX96After: q.sqrtPriceX96After?.toString(),
      reminder: "amount*Ui is display-only; the chain uses raw. Price is how much quote asset 1 share is worth, not how many shares 1 USDT buys.",
    });
  }

  if (name === "plan_swap_then_lp") {
    const q = await quoteSwap({
      tokenIn: String(args.tokenIn),
      tokenOut: String(args.tokenOut),
      amountInUi: String(args.amountInUi),
      minPoolTvlUsd: loadRiskConfig().minPoolLiquidityUsd,
      client,
    });
    const swap = {
      tokenIn: q.nativeIn ? "BNB" : q.tokenIn.symbol,
      tokenOut: q.nativeOut ? "BNB" : q.tokenOut.symbol,
      amountInUi: q.amountInUi,
    };
    const lpQuote = String(args.lpQuote === "BNB" ? "WBNB" : args.lpQuote);
    const lp = {
      token: getToken(String(args.lpToken)).symbol,
      quote: getToken(lpQuote).symbol,
      fee: args.lpFee != null ? Number(args.lpFee) : undefined,
      budgetQuoteUi: String(args.budgetQuoteUi),
      rangeBps: DEFAULT_LP_RANGE_BPS,
      committed: true,
    };
    ctx.conversation.lastQuote = swap;
    ctx.conversation.lastLp = lp;
    ctx.conversation.pendingPlan = { kind: "swap_then_lp", phase: "swap", swap, lp };
    ctx.conversations.save(ctx.conversation);
    return serializeToolResult({
      kind: "swap_then_lp",
      phase: "swap",
      swap,
      amountOutUi: q.amountOutUi,
      lp,
      fee: q.fee,
      nativeIn: q.nativeIn,
      hops: q.hops,
      reminder: "Two signatures. Confirm now for the funding swap. After that swap is signed, the LP signer opens automatically (or say 继续). Not investment advice.",
    });
  }

  if (name === "compare_lp_pools") {
    const compared = await compareLpPools(resolveSpokenBstock(String(args.token)).symbol);
    ctx.conversation.lastLpCompare = compared;
    if (ctx.conversation.pendingPlan?.kind !== "swap_then_lp") {
      delete ctx.conversation.lastQuote;
    }
    ctx.conversations.save(ctx.conversation);
    return serializeToolResult(compared);
  }

  if (name === "propose_lp") {
    const wallet = ctx.conversation.wallet;
    if (!wallet) throw new Error("No user wallet recorded yet.");
    const last = ctx.conversation.lastIntent;
    if (last?.id && last.kind.startsWith("lp") && !last.cancelled) {
      try {
        const existing = ctx.intents.get(last.id);
        if (existing && existing.txHashes.length === 0 && !existing.cancelledAt) {
          ctx.intents.cancel(last.id);
          const s = ctx.conversations.get(ctx.conversation.id);
          if (s.lastIntent) s.lastIntent = { ...s.lastIntent, cancelled: true };
          ctx.conversations.save(s);
          ctx.conversation = s;
        }
      } catch {
        /* ignore */
      }
    }
    const proposal = await buildLpProposal({
      token: resolveSpokenBstock(String(args.token || "NVDAB")).symbol,
      wallet,
      client,
    });
    const s = ctx.conversations.get(ctx.conversation.id);
    delete s.lastQuote;
    delete s.lastLp;
    delete s.pendingPlan;
    s.lastLpProposal = proposal;
    ctx.conversations.save(s);
    ctx.conversation = s;
    return serializeToolResult(proposal);
  }

  if (name === "analyze_lp") {
    const rangeBps = args.rangeBps != null ? Number(args.rangeBps) : DEFAULT_LP_RANGE_BPS;
    const analysis = await analyzeLp({
      token: resolveSpokenBstock(String(args.token)).symbol,
      quote: args.quote,
      fee: args.fee != null ? Number(args.fee) : undefined,
      rangeBps,
      client,
    });
    const token = resolveSpokenBstock(String(args.token)).symbol;
    const quote = args.quote
      ? getToken(String(args.quote === "BNB" ? "WBNB" : args.quote)).symbol
      : ctx.conversation.lastLp?.quote;
    ctx.conversation.lastLp = {
      ...ctx.conversation.lastLp,
      token,
      quote,
      fee: analysis.fee,
      rangeBps: analysis.suggestedRangeBps,
    };
    if (ctx.conversation.lastQuote && parkedMint(ctx.conversation.lastLp)) {
      latchSwapThenLpPlan(ctx.conversation, ctx.conversation.lastQuote, ctx.conversation.lastLp);
    } else if (ctx.conversation.pendingPlan?.kind !== "swap_then_lp") {
      delete ctx.conversation.lastQuote;
    }
    ctx.conversations.save(ctx.conversation);
    return serializeToolResult(analysis);
  }

  if (name === "list_positions") {
    if (!ctx.conversation.wallet) throw new Error("No user wallet recorded yet.");
    const positions = await listPositions(ctx.conversation.wallet, client);
    return serializeToolResult({ wallet: ctx.conversation.wallet, count: positions.length, positions });
  }

  if (name === "read_balance") {
    if (!args.account && !ctx.conversation.wallet) throw new Error("No user wallet recorded yet.");
    const requested = String(args.token);
    const token = getToken(requested);
    const account = getAddress(String(args.account ?? ctx.conversation.wallet ?? "")) as Address;
    const native = wantsNativeBnb(requested);
    const bal = await readBalanceUi(client, token, account, { native });
    return serializeToolResult({
      symbol: swapAssetSymbol(requested),
      uiDisplay: bal.uiDisplay,
      raw: bal.raw,
      native,
      wallet: account,
    });
  }

  if (name === "create_swap_intent") {
    const blocked = gateDefiHire(ctx.conversation);
    if (blocked) return blocked;
    const plan = ctx.conversation.pendingPlan;
    if (plan?.kind === "swap_then_lp" && plan.phase !== "lp") {
      const existing = resolvePlanSwapIntent(ctx);
      if (existing && !existing.cancelledAt) {
        if (intentFilled(existing)) {
          return serializeToolResult(await continueSwapThenLp(ctx, existing));
        }
        return withGasWarning(ctx.conversation.wallet, {
          intentId: existing.id,
          signerUrl: signerOf(ctx, existing),
          expiresAt: existing.expiresAt,
          summary: existing.summary,
          note: "第一步签名页还在，请用同一链接签完兑换。签完后会自动出 LP 页。",
        });
      }
      args.tokenIn = plan.swap.tokenIn;
      args.tokenOut = plan.swap.tokenOut;
      args.amountInUi = plan.swap.amountInUi;
    }
    gate(ctx.conversation);
    const cfg = loadRiskConfig();
    const slippageBps = Number(args.slippageBps ?? cfg.defaultSlippageBps);
    const tokenInArg = String(args.tokenIn);
    const tokenOutArg = String(args.tokenOut);
    const nativeIn = wantsNativeBnb(tokenInArg);
    const nativeOut = wantsNativeBnb(tokenOutArg);
    const tokenIn = getToken(tokenInArg);
    const tokenOut = getToken(tokenOutArg);
    const bal = await readBalanceUi(client, tokenIn, ctx.conversation.wallet!, { native: nativeIn });
    const need = (await quoteSwap({
      tokenIn: tokenInArg,
      tokenOut: tokenOutArg,
      amountInUi: String(args.amountInUi),
      fee: args.fee != null ? Number(args.fee) : undefined,
      minPoolTvlUsd: cfg.minPoolLiquidityUsd,
      client,
    })).amountInRaw;
    if (bal.raw < need) {
      const symbol = nativeIn ? "BNB" : tokenIn.symbol;
      return serializeToolResult({
        error: "insufficient_balance",
        message: `Insufficient balance: wallet has ${bal.uiDisplay} ${symbol}, this trade needs ${args.amountInUi}.`,
      });
    }
    const built = await buildSwapTxs({
      tokenIn: tokenInArg,
      tokenOut: tokenOutArg,
      amountInUi: String(args.amountInUi),
      fee: args.fee != null ? Number(args.fee) : undefined,
      minPoolTvlUsd: cfg.minPoolLiquidityUsd,
      recipient: ctx.conversation.wallet!,
      slippageBps,
      deadlineSeconds: cfg.deadlineSeconds,
      client,
    });
    const bstock = tokenIn.kind === "bstock" ? tokenIn : tokenOut.kind === "bstock" ? tokenOut : tokenOut;
    const stable = tokenIn.kind === "stable" ? tokenIn : tokenOut.kind === "stable" ? tokenOut : getToken("USDT");
    let mid = 0;
    try {
      mid = await midQuotePerShare(bstock.symbol, stable.symbol, client);
    } catch {
      mid = 0;
    }
    const exec = executionQuotePerUnit({
      tokenIn,
      tokenOut,
      amountInUi: built.quote.amountInUi,
      amountOutUi: built.quote.amountOutUi,
    });
    let poolTvl = 0;
    if (built.quote.pool) {
      try {
        const pairToken = tokenIn.kind === "bstock" ? tokenIn.symbol : tokenOut.symbol;
        const analysis = await analyzeLp({ token: pairToken, quote: stable.symbol, fee: built.quote.fee, client });
        poolTvl = parseUiNumber(analysis.tvlUsdApprox);
      } catch {
        poolTvl = 0;
      }
    }
    let notional = swapNotionalUsd({
      tokenIn,
      tokenOut,
      amountInUi: built.quote.amountInUi,
      amountOutUi: built.quote.amountOutUi,
      midQuotePerUnit: mid,
    });
    if (nativeIn || tokenIn.kind === "gas") {
      try {
        const bnbUsd = await quoteSwap({
          tokenIn: "WBNB",
          tokenOut: "USDT",
          amountInUi: String(args.amountInUi),
          client,
        });
        notional = parseUiNumber(bnbUsd.amountOutUi);
      } catch {
        /* keep swapNotionalUsd */
      }
    }
    const verdict = riskFor({
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      slippageBps,
      notionalUsd: notional,
      poolLiquidityUsd: poolTvl,
      priceDeviationBps: priceDeviationBps(exec, mid),
      amountMin: built.amountOutMin,
      state: ctx.conversation,
    });
    if (!verdict.ok) return serializeToolResult({ error: "risk_blocked", blockers: verdict.blockers });
    const displayIn = nativeIn || built.quote.nativeIn ? "BNB" : built.quote.tokenIn.symbol;
    const displayOut = nativeOut || built.quote.nativeOut ? "BNB" : built.quote.tokenOut.symbol;
    const parked =
      ctx.conversation.pendingPlan?.kind === "swap_then_lp"
        ? ctx.conversation.pendingPlan.lp
        : parkedMint(ctx.conversation.lastLp)
          ? ctx.conversation.lastLp
          : (() => {
              const opt = fundOptionForSwap(ctx.conversation.lastLpProposal, {
                tokenIn: displayIn,
                tokenOut: displayOut,
                amountInUi: built.quote.amountInUi,
              });
              return opt ? pendingLpFromOption(opt) : undefined;
            })();
    const intent = ctx.intents.create({
      kind: "swap",
      conversationId: ctx.conversation.id,
      userAddress: ctx.conversation.wallet!,
      txs: built.txs,
      summary: {
        tokenIn: displayIn,
        tokenOut: displayOut,
        amountInUi: built.quote.amountInUi,
        amountOutUi: built.quote.amountOutUi,
        amountInRaw: built.quote.amountInRaw.toString(),
        amountOutRaw: built.quote.amountOutRaw.toString(),
        amountOutMin: built.amountOutMin.toString(),
        slippageBps,
        route: built.quote.route,
        hops: built.quote.hops,
        nativeIn: built.quote.nativeIn,
        nativeOut: built.quote.nativeOut,
        notionalUsd: notional.toFixed(2),
        midQuotePerToken: mid || undefined,
        ...(parked ? { parkedLp: parked } : {}),
      },
      risks: [
        ...verdict.warnings,
        ...built.notes,
        ...(built.quote.tokenIn.scaledUi ? ["Input token uses ERC-8056"] : []),
        ...(built.quote.nativeIn ? ["You are spending native BNB from the wallet, not WBNB."] : []),
        ...(built.quote.nativeOut ? ["The swap unwraps to native BNB."] : []),
      ],
      simulation: await intentSimulation(client, ctx.conversation.wallet!, built.txs),
    });
    afterCreateSwapIntent(ctx, intent.id);
    const signerUrl = signerOf(ctx, intent);
    rememberCreatedIntent(ctx, { id: intent.id, kind: "swap", signerUrl, summary: intent.summary });
    return withGasWarning(ctx.conversation.wallet, {
      intentId: intent.id,
      signerUrl,
      expiresAt: intent.expiresAt,
      summary: intent.summary,
    });
  }

  if (name === "create_lp_intent") {
    const blocked = gateDefiHire(ctx.conversation);
    if (blocked) return blocked;
    gate(ctx.conversation);
    const cfg = loadRiskConfig();
    const token = resolveSpokenBstock(String(args.token ?? "NVDAB")).symbol;
    if (args.collectTokenId) {
      const tokenId = BigInt(String(args.collectTokenId));
      const pos = await readPosition(tokenId, client);
      assertPositionOwner(pos.owner, ctx.conversation.wallet!);
      const tx = await buildCollectTx({ userAddress: ctx.conversation.wallet!, tokenId });
      const tvl = parseUiNumber(pos.snapshot.markUsd) || parseUiNumber(pos.snapshot.feesUsdApprox);
      const verdict = riskFor({
        tokenIn: pos.token0.symbol,
        tokenOut: pos.token1.symbol,
        slippageBps: cfg.defaultSlippageBps,
        notionalUsd: parseUiNumber(pos.snapshot.feesUsdApprox),
        poolLiquidityUsd: tvl > 0 ? Math.max(tvl, cfg.minPoolLiquidityUsd) : 0,
        priceDeviationBps: 0,
        amountMin: 1n,
        state: ctx.conversation,
      });
      if (!verdict.ok) return serializeToolResult({ error: "risk_blocked", blockers: verdict.blockers });
      const intent = ctx.intents.create({
        kind: "lp-collect",
        conversationId: ctx.conversation.id,
        userAddress: ctx.conversation.wallet!,
        txs: [tx],
        summary: {
          tokenId: String(tokenId),
          token0: pos.token0.symbol,
          token1: pos.token1.symbol,
          amount0Ui: pos.snapshot.tokensOwed0Ui,
          amount1Ui: pos.snapshot.tokensOwed1Ui,
          analysis: { token0: pos.token0.symbol, token1: pos.token1.symbol },
        },
        risks: [...verdict.warnings, "Collecting fees does not remove principal, but the user must sign."],
        simulation: await intentSimulation(client, ctx.conversation.wallet!, [tx]),
      });
      consumePending(ctx);
      const signerUrl = signerOf(ctx, intent);
      rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-collect", signerUrl, summary: intent.summary });
      return withGasWarning(ctx.conversation.wallet, { intentId: intent.id, signerUrl, summary: intent.summary });
    }
    if (args.decreaseTokenId) {
      const built = await buildDecreaseLpTxs({
        userAddress: ctx.conversation.wallet!,
        tokenId: BigInt(String(args.decreaseTokenId)),
        decreaseBps: Number(args.decreaseBps ?? 10_000),
        slippageBps: cfg.defaultSlippageBps,
        deadlineSeconds: cfg.deadlineSeconds,
        client,
      });
      const notional = parseUiNumber(String(built.summary.amount0Ui ?? "0")) + parseUiNumber(String(built.summary.amount1Ui ?? "0"));
      const verdict = riskFor({
        tokenIn: String(built.summary.token0 ?? token),
        tokenOut: String(built.summary.token1 ?? "USDT"),
        slippageBps: cfg.defaultSlippageBps,
        notionalUsd: parseUiNumber(built.analysis.tvlUsdApprox) ? notional : notional,
        poolLiquidityUsd: parseUiNumber(built.analysis.tvlUsdApprox),
        priceDeviationBps: 0,
        amountMin: built.amount0Min,
        state: ctx.conversation,
      });
      if (!verdict.ok) return serializeToolResult({ error: "risk_blocked", blockers: verdict.blockers });
      const intent = ctx.intents.create({
        kind: "lp-decrease",
        conversationId: ctx.conversation.id,
        userAddress: ctx.conversation.wallet!,
        txs: built.txs,
        summary: built.summary,
        risks: [...verdict.warnings, ...built.analysis.warnings],
        simulation: await intentSimulation(client, ctx.conversation.wallet!, built.txs),
      });
      consumePending(ctx);
      const signerUrl = signerOf(ctx, intent);
      rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-decrease", signerUrl, summary: intent.summary });
      return withGasWarning(ctx.conversation.wallet, { intentId: intent.id, signerUrl, summary: intent.summary });
    }
    if (args.increaseTokenId) {
      if (!args.amountTokenUi) throw new Error("Increase needs amountTokenUi");
      const built = await buildIncreaseLpTxs({
        userAddress: ctx.conversation.wallet!,
        tokenId: BigInt(String(args.increaseTokenId)),
        amountTokenUi: String(args.amountTokenUi),
        amountQuoteUi: args.amountQuoteUi ? String(args.amountQuoteUi) : undefined,
        slippageBps: cfg.defaultSlippageBps,
        deadlineSeconds: cfg.deadlineSeconds,
        client,
      });
      const notional = parseUiNumber(String(built.summary.amount1Ui ?? built.summary.amount0Ui ?? "0"));
      const verdict = riskFor({
        tokenIn: token,
        tokenOut: "USDT",
        slippageBps: cfg.defaultSlippageBps,
        notionalUsd: notional,
        poolLiquidityUsd: parseUiNumber(built.analysis.tvlUsdApprox),
        priceDeviationBps: 0,
        amountMin: built.amount0Min,
        state: ctx.conversation,
      });
      if (!verdict.ok) return serializeToolResult({ error: "risk_blocked", blockers: verdict.blockers });
      const intent = ctx.intents.create({
        kind: "lp-increase",
        conversationId: ctx.conversation.id,
        userAddress: ctx.conversation.wallet!,
        txs: built.txs,
        summary: built.summary,
        risks: [...verdict.warnings, ...built.analysis.warnings],
        simulation: await intentSimulation(client, ctx.conversation.wallet!, built.txs),
      });
      consumePending(ctx);
      const signerUrl = signerOf(ctx, intent);
      rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-increase", signerUrl, summary: intent.summary });
      return withGasWarning(ctx.conversation.wallet, { intentId: intent.id, signerUrl, summary: intent.summary });
    }
    if (!args.amountTokenUi && !args.amountQuoteUi && !args.budgetQuoteUi) {
      throw new Error("Mint needs amountTokenUi, amountQuoteUi, or budgetQuoteUi");
    }
    const built = await buildMintLpTxs({
      userAddress: ctx.conversation.wallet!,
      token,
      quote: args.quote ? String(args.quote) : ctx.conversation.lastLp?.quote,
      amountTokenUi: args.amountTokenUi ? String(args.amountTokenUi) : undefined,
      amountQuoteUi: args.amountQuoteUi ? String(args.amountQuoteUi) : undefined,
      budgetQuoteUi: args.budgetQuoteUi ? String(args.budgetQuoteUi) : undefined,
      rangeBps: args.rangeBps != null ? Number(args.rangeBps) : DEFAULT_LP_RANGE_BPS,
      fee: args.fee != null ? Number(args.fee) : ctx.conversation.lastLp?.fee,
      slippageBps: cfg.defaultSlippageBps,
      deadlineSeconds: cfg.deadlineSeconds,
      client,
    });
    const notional = parseUiNumber(built.analysis.tvlUsdApprox)
      ? parseUiNumber(String(built.summary.amount1Ui ?? "0")) +
        parseUiNumber(String(built.summary.amount0Ui ?? "0")) *
          (parseUiNumber(String(built.summary.midQuotePerToken ?? "0")) || 0)
      : parseUiNumber(String(args.amountQuoteUi ?? "0"));
    const mark =
      parseUiNumber(String(built.summary.amount1Ui ?? "0")) +
      parseUiNumber(String(built.summary.amount0Ui ?? "0")) *
        (parseUiNumber(String(built.summary.midQuotePerToken ?? "0")) || 1);
    const quote = String(args.quote ?? ctx.conversation.lastLp?.quote ?? "USDT");
    const verdict = riskFor({
      tokenIn: token,
      tokenOut: quote,
      slippageBps: cfg.defaultSlippageBps,
      notionalUsd: mark || notional,
      poolLiquidityUsd: parseUiNumber(built.analysis.tvlUsdApprox),
      priceDeviationBps: 0,
      amountMin: built.amount0Min > 0n ? built.amount0Min : built.amount1Min,
      state: ctx.conversation,
    });
    if (!verdict.ok) return serializeToolResult({ error: "risk_blocked", blockers: verdict.blockers });
    const t0 = getToken(String(built.summary.token0));
    const t1 = getToken(String(built.summary.token1));
    const b0 = await readBalanceUi(client, t0, ctx.conversation.wallet!);
    const b1 = await readBalanceUi(client, t1, ctx.conversation.wallet!);
    if (b0.raw < built.amount0Desired || b1.raw < built.amount1Desired) {
      return serializeToolResult({
        error: "insufficient_balance",
        message: `钱包不够组这笔 LP：需要 ${built.summary.amount0Ui} ${t0.symbol} + ${built.summary.amount1Ui} ${t1.symbol}，当前 ${b0.uiDisplay} ${t0.symbol} + ${b1.uiDisplay} ${t1.symbol}。回复「组 LP」按现在的余额重新给可选方案，不要硬签会失败的页。`,
      });
    }
    const simulation = await intentSimulation(client, ctx.conversation.wallet!, built.txs);
    if (!simulation.ok) {
      return serializeToolResult({
        error: "sim_failed",
        message: `链上模拟失败，没有生成签名页。${simulation.notes.join(" ")} 回复「组 LP」按钱包重新给方案。`,
      });
    }
    const intent = ctx.intents.create({
      kind: "lp-mint",
      conversationId: ctx.conversation.id,
      userAddress: ctx.conversation.wallet!,
      txs: built.txs,
      summary: built.summary,
      risks: [...verdict.warnings, ...built.analysis.warnings],
      simulation,
    });
    consumePending(ctx);
    const signerUrl = signerOf(ctx, intent);
    rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-mint", signerUrl, summary: intent.summary });
    return withGasWarning(ctx.conversation.wallet, { intentId: intent.id, signerUrl, summary: intent.summary });
  }

  if (name === "verify_tx") {
    const hash = String(args.txHash) as Hex;
    const receipt = await client.getTransactionReceipt({ hash });
    return serializeToolResult({
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      from: receipt.from,
      to: receipt.to,
    });
  }

  if (name === "generate_report") {
    let positions: unknown[] = [];
    if (ctx.conversation.wallet) {
      try {
        positions = await listPositions(ctx.conversation.wallet, client);
      } catch {
        positions = [];
      }
    }
    const intents = ctx.intents
      .list()
      .filter((i) => !ctx.conversation.wallet || i.userAddress.toLowerCase() === ctx.conversation.wallet.toLowerCase())
      .slice(-20)
      .map((i) => ({ id: i.id, kind: i.kind, cancelledAt: i.cancelledAt, txHashes: i.txHashes }));
    const report = buildDeliveryReport({
      title: String(args.title ?? "bStocks / Pancake V3 delivery report"),
      userAddress: ctx.conversation.wallet,
      orderId: ctx.conversation.lastOrderId,
      txs: (args.txs ?? []) as Array<{ kind: string; hash: string; note?: string }>,
      notes: (args.notes ?? ["Generated by the agent from this conversation."]) as string[],
      positions,
      intents,
    });
    const md = renderMarkdown(report);
    const file = join(ctx.dataDir, "reports", `${Date.now()}.md`);
    writeFileSync(file, md);
    return serializeToolResult({ file, markdown: md, json: report });
  }

  if (name === "send_termix_offer") {
    if (!ctx.conversation.geoConfirmed) {
      throw new Error("Geo not confirmed. Ask the user to declare they are not in the US or a restricted region.");
    }
    const res = await sendStandardOffer(ctx, args.message ? String(args.message) : undefined);
    ctx.conversations.consumeConfirm(ctx.conversation.id);
    ctx.conversation.userConfirmed = false;
    return serializeToolResult(res);
  }

  if (name === "provider_accept_order") {
    await refreshHireFromTermix(ctx);
    const res = await acceptFundedOrder(ctx, args.orderId ? String(args.orderId) : undefined);
    return withGasWarning(ctx.conversation.wallet, { ...res });
  }

  if (name === "submit_termix_delivery") {
    await refreshHireFromTermix(ctx);
    const res = await submitHireDelivery(ctx, args.orderId ? String(args.orderId) : undefined, {
      confirmEmpty: Boolean(args.confirmEmpty),
    });
    return serializeToolResult(res);
  }

  throw new Error(`Unknown tool ${name}`);
}
