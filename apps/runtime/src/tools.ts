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
  simulatePreparedTxs,
  swapAssetSymbol,
  swapNotionalUsd,
  wantsNativeBnb,
  type PreparedTx,
} from "@bstocks/chain";
import { evaluateRisk, loadRiskConfig } from "@bstocks/risk";
import { sendConversationOffer, TermixClient } from "@bstocks/termix";
import { buildDeliveryReport, renderMarkdown } from "@bstocks/report";
import type { ConversationState, ConversationStore } from "./conversation.js";
import type { IntentStore } from "./intents.js";
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
      description:
        "List whitelist V3 pools for a bStock (USDT/USDC/WBNB) with Pancake Explorer 24h fee APR, TVL, and volume. Use for 最高apr / 哪个池收益高. Does not create an intent.",
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
        "Create a user-signed swap intent from the pending quote. Requires geo + explicit confirm. If lastQuote exists, call this immediately on 确认 — do not re-ask the pair or amount.",
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
      description: "Send a custom USDT offer in the current Termix conversation. Requires confirm.",
      parameters: {
        type: "object",
        properties: {
          price: { type: "string" },
          scope: { type: "string" },
          message: { type: "string" },
        },
        required: ["price", "scope"],
      },
    },
  },
] as const;

function rememberCreatedIntent(
  ctx: ToolCtx,
  intent: { id: string; kind: string; signerUrl: string; summary?: Record<string, unknown> },
) {
  ctx.conversations.rememberIntent(ctx.conversation.id, intent);
  ctx.conversation.lastIntent = ctx.conversations.get(ctx.conversation.id).lastIntent;
}

function gate(state: ConversationState) {
  if (!state.geoConfirmed) {
    throw new Error("地理确认未完成：请用户声明不在美国及受限地区后再执行。");
  }
  if (!state.userConfirmed) {
    throw new Error("用户尚未明确确认。请先展示方案，等用户回复「确认执行」。");
  }
  if (!state.wallet) {
    throw new Error("尚未记录用户钱包地址。请用户发送 0x 地址。");
  }
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
  ctx.conversation.userConfirmed = false;
}

function signerOf(ctx: ToolCtx, intent: { id: string }) {
  return `${ctx.signerWebUrl}/t/${intent.id}`;
}

async function intentSimulation(client: PublicClient, account: Address, txs: PreparedTx[]) {
  try {
    const sim = await simulatePreparedTxs(client, account, txs);
    const gas = sim.gasFeeWei > 0n ? `预估矿工费约 ${formatEther(sim.gasFeeWei)} BNB` : undefined;
    return {
      ok: !sim.hardFail,
      notes: [...sim.notes, gas].filter((x): x is string => Boolean(x)),
    };
  } catch (err) {
    return {
      ok: true,
      notes: [`Runtime 模拟未完成：${err instanceof Error ? err.message : String(err)}。签名页将再模拟。`],
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
    const token = getToken(String(args.token)).symbol;
    const quote = getToken(String(args.quote ?? "USDT")).symbol;
    const q = await quoteSwap({ tokenIn: token, tokenOut: quote, amountInUi: "1", client });
    return JSON.stringify({
      token,
      requested: String(args.token),
      quote,
      uiPrice: q.amountOutUi,
      display: `${token} ≈ ${q.amountOutUi} ${quote} / 股`,
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
      client,
    });
    ctx.conversation.lastQuote = {
      tokenIn: q.nativeIn ? "BNB" : q.tokenIn.symbol,
      tokenOut: q.nativeOut ? "BNB" : q.tokenOut.symbol,
      amountInUi: q.amountInUi,
    };
    delete ctx.conversation.lastLp;
    ctx.conversations.save(ctx.conversation);
    return JSON.stringify({
      ...q,
      amountInRaw: q.amountInRaw.toString(),
      amountOutRaw: q.amountOutRaw.toString(),
      sqrtPriceX96After: q.sqrtPriceX96After?.toString(),
      reminder: "以上 amount*Ui 仅供展示；链上使用 raw。查价请看 1 股值多少报价资产，不要用 1 USDT 买多少股当股价。",
    });
  }

  if (name === "compare_lp_pools") {
    const compared = await compareLpPools(String(args.token));
    ctx.conversation.lastLpCompare = compared;
    delete ctx.conversation.lastQuote;
    ctx.conversations.save(ctx.conversation);
    return JSON.stringify(compared);
  }

  if (name === "analyze_lp") {
    const rangeBps = args.rangeBps != null ? Number(args.rangeBps) : DEFAULT_LP_RANGE_BPS;
    const analysis = await analyzeLp({
      token: String(args.token),
      quote: args.quote,
      fee: args.fee != null ? Number(args.fee) : undefined,
      rangeBps,
      client,
    });
    const token = getToken(String(args.token)).symbol;
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
    delete ctx.conversation.lastQuote;
    ctx.conversations.save(ctx.conversation);
    return JSON.stringify(analysis);
  }

  if (name === "list_positions") {
    if (!ctx.conversation.wallet) throw new Error("尚未记录用户钱包地址。");
    const positions = await listPositions(ctx.conversation.wallet, client);
    return JSON.stringify({ wallet: ctx.conversation.wallet, count: positions.length, positions });
  }

  if (name === "read_balance") {
    const requested = String(args.token);
    const token = getToken(requested);
    const account = getAddress(String(args.account ?? ctx.conversation.wallet ?? "")) as Address;
    const bal = await readBalanceUi(client, token, account, { native: wantsNativeBnb(requested) });
    return JSON.stringify({ ...bal, symbol: swapAssetSymbol(requested) });
  }

  if (name === "create_swap_intent") {
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
      client,
    })).amountInRaw;
    if (bal.raw < need) {
      const symbol = nativeIn ? "BNB" : tokenIn.symbol;
      return JSON.stringify({
        error: "insufficient_balance",
        message: `余额不足：钱包有 ${bal.uiDisplay} ${symbol}，这笔要 ${args.amountInUi}。`,
      });
    }
    const built = await buildSwapTxs({
      tokenIn: tokenInArg,
      tokenOut: tokenOutArg,
      amountInUi: String(args.amountInUi),
      fee: args.fee != null ? Number(args.fee) : undefined,
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
    if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
    const displayIn = nativeIn || built.quote.nativeIn ? "BNB" : built.quote.tokenIn.symbol;
    const displayOut = nativeOut || built.quote.nativeOut ? "BNB" : built.quote.tokenOut.symbol;
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
      },
      risks: [
        ...verdict.warnings,
        ...built.notes,
        ...(built.quote.tokenIn.scaledUi ? ["输入代币启用了 ERC-8056"] : []),
        ...(built.quote.nativeIn ? ["付出的是钱包里的原生 BNB，不是 WBNB。"] : []),
        ...(built.quote.nativeOut ? ["兑换结果会 unwrap 成原生 BNB。"] : []),
      ],
      simulation: await intentSimulation(client, ctx.conversation.wallet!, built.txs),
    });
    consumePending(ctx);
    const signerUrl = signerOf(ctx, intent);
    rememberCreatedIntent(ctx, { id: intent.id, kind: "swap", signerUrl, summary: intent.summary });
    return JSON.stringify({
      intentId: intent.id,
      signerUrl,
      expiresAt: intent.expiresAt,
      summary: intent.summary,
    });
  }

  if (name === "create_lp_intent") {
    gate(ctx.conversation);
    const cfg = loadRiskConfig();
    const token = String(args.token ?? "NVDAB");
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
      if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
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
        risks: [...verdict.warnings, "收取手续费不会移除本金，但需用户自行签名。"],
        simulation: await intentSimulation(client, ctx.conversation.wallet!, [tx]),
      });
      consumePending(ctx);
      const signerUrl = signerOf(ctx, intent);
      rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-collect", signerUrl, summary: intent.summary });
      return JSON.stringify({ intentId: intent.id, signerUrl, summary: intent.summary });
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
      if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
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
      return JSON.stringify({ intentId: intent.id, signerUrl, summary: intent.summary });
    }
    if (args.increaseTokenId) {
      if (!args.amountTokenUi) throw new Error("加仓需要 amountTokenUi");
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
      if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
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
      return JSON.stringify({ intentId: intent.id, signerUrl, summary: intent.summary });
    }
    if (!args.amountTokenUi && !args.amountQuoteUi && !args.budgetQuoteUi) {
      throw new Error("加池需要 amountTokenUi、amountQuoteUi 或 budgetQuoteUi");
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
    if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
    const intent = ctx.intents.create({
      kind: "lp-mint",
      conversationId: ctx.conversation.id,
      userAddress: ctx.conversation.wallet!,
      txs: built.txs,
      summary: built.summary,
      risks: [...verdict.warnings, ...built.analysis.warnings],
      simulation: await intentSimulation(client, ctx.conversation.wallet!, built.txs),
    });
    consumePending(ctx);
    const signerUrl = signerOf(ctx, intent);
    rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-mint", signerUrl, summary: intent.summary });
    return JSON.stringify({ intentId: intent.id, signerUrl, summary: intent.summary });
  }

  if (name === "verify_tx") {
    const hash = String(args.txHash) as Hex;
    const receipt = await client.getTransactionReceipt({ hash });
    return JSON.stringify({
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
      title: String(args.title ?? "bStocks / Pancake V3 交付报告"),
      userAddress: ctx.conversation.wallet,
      orderId: ctx.conversation.lastOrderId,
      txs: (args.txs ?? []) as Array<{ kind: string; hash: string; note?: string }>,
      notes: (args.notes ?? ["由 Agent 根据本轮对话生成。"]) as string[],
      positions,
      intents,
    });
    const md = renderMarkdown(report);
    const file = join(ctx.dataDir, "reports", `${Date.now()}.md`);
    writeFileSync(file, md);
    return JSON.stringify({ file, markdown: md, json: report });
  }

  if (name === "send_termix_offer") {
    gate(ctx.conversation);
    if (!ctx.termix || !ctx.agentId) {
      return JSON.stringify({ error: "termix_not_configured", hint: "设置 TERMIX_AGENT_ID 与 WALLET_KEY 后可发 offer。" });
    }
    const res = await sendConversationOffer(ctx.termix, ctx.conversation.id, {
      providerAgentId: ctx.agentId,
      price: String(args.price),
      currency: "USDT",
      deliveryDays: 3,
      scope: String(args.scope),
      message: args.message ? String(args.message) : undefined,
      proofMethod: "manual",
      settlementType: "escrow",
    });
    ctx.conversations.consumeConfirm(ctx.conversation.id);
    return JSON.stringify({ ok: true, offer: res });
  }

  throw new Error(`Unknown tool ${name}`);
}
