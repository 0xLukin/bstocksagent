import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  analyzeLp,
  buildCollectTx,
  buildMintLpTxs,
  buildSwapTxs,
  getPublicClient,
  getToken,
  isWhitelisted,
  quoteSwap,
  readBalanceUi,
  readPosition,
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
        "Read a whitelist bStock mid price via V3 quote of 1 quote unit. token accepts on-chain symbols or aliases (NVDAB, NVDA, bNVDA, 英伟达).",
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
      description: "Quote a whitelist V3 swap. Amount is UI display units.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: { type: "string" },
          tokenOut: { type: "string" },
          amountInUi: { type: "string" },
        },
        required: ["tokenIn", "tokenOut", "amountInUi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_lp",
      description: "Read Pancake V3 pool state and IL warnings.",
      parameters: {
        type: "object",
        properties: { token: { type: "string" }, quote: { type: "string" } },
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
        },
        required: ["tokenIn", "tokenOut", "amountInUi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_lp_intent",
      description: "Create a user-signed LP mint or collect intent. Requires geo + confirm.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string" },
          amountTokenUi: { type: "string" },
          amountQuoteUi: { type: "string" },
          collectTokenId: { type: "string" },
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
      description: "Build a delivery markdown/json report.",
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
    priceDeviationBps: 0,
    amountMin: args.amountMin,
    geoConfirmed: args.state.geoConfirmed,
    userConfirmed: args.state.userConfirmed,
  });
}

export async function runTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const client = ctx.client ?? getPublicClient();

  if (name === "get_bstock_price") {
    const token = getToken(String(args.token)).symbol;
    const quote = getToken(String(args.quote ?? "USDT")).symbol;
    const q = await quoteSwap({ tokenIn: quote, tokenOut: token, amountInUi: "1", client });
    return JSON.stringify({
      token,
      requested: String(args.token),
      quote,
      uiPriceApprox: q.amountOutUi,
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
      client,
    });
    ctx.conversation.lastQuote = {
      tokenIn: q.tokenIn.symbol,
      tokenOut: q.tokenOut.symbol,
      amountInUi: q.amountInUi,
    };
    delete ctx.conversation.lastLp;
    ctx.conversations.save(ctx.conversation);
    return JSON.stringify({
      ...q,
      amountInRaw: q.amountInRaw.toString(),
      amountOutRaw: q.amountOutRaw.toString(),
      sqrtPriceX96After: q.sqrtPriceX96After?.toString(),
      reminder: "以上 amount*Ui 仅供展示；链上使用 raw。",
    });
  }

  if (name === "analyze_lp") {
    return JSON.stringify(await analyzeLp({ token: String(args.token), quote: args.quote, client }));
  }

  if (name === "create_swap_intent") {
    gate(ctx.conversation);
    const cfg = loadRiskConfig();
    const slippageBps = Number(args.slippageBps ?? cfg.defaultSlippageBps);
    const built = await buildSwapTxs({
      tokenIn: String(args.tokenIn),
      tokenOut: String(args.tokenOut),
      amountInUi: String(args.amountInUi),
      recipient: ctx.conversation.wallet!,
      slippageBps,
      deadlineSeconds: cfg.deadlineSeconds,
      client,
    });
    const notional = Number(args.amountInUi);
    const verdict = riskFor({
      tokenIn: String(args.tokenIn),
      tokenOut: String(args.tokenOut),
      slippageBps,
      notionalUsd: Number.isFinite(notional) ? notional : 0,
      poolLiquidityUsd: 50_000,
      amountMin: built.amountOutMin,
      state: ctx.conversation,
    });
    if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
    const intent = ctx.intents.create({
      kind: "swap",
      userAddress: ctx.conversation.wallet!,
      txs: built.txs,
      summary: {
        tokenIn: built.quote.tokenIn.symbol,
        tokenOut: built.quote.tokenOut.symbol,
        amountInUi: built.quote.amountInUi,
        amountOutUi: built.quote.amountOutUi,
        amountInRaw: built.quote.amountInRaw.toString(),
        amountOutRaw: built.quote.amountOutRaw.toString(),
        amountOutMin: built.amountOutMin.toString(),
        slippageBps,
        route: built.quote.route,
      },
      risks: [...verdict.warnings, ...built.quote.tokenIn.scaledUi ? ["输入代币启用了 ERC-8056"] : []],
    });
    ctx.conversations.consumeConfirm(ctx.conversation.id);
    ctx.conversations.clearPending(ctx.conversation.id);
    delete ctx.conversation.lastQuote;
    ctx.conversation.userConfirmed = false;
    const signerUrl = `${ctx.signerWebUrl}/t/${intent.id}`;
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
    if (args.collectTokenId) {
      const tokenId = BigInt(String(args.collectTokenId));
      const pos = await readPosition(tokenId, client);
      const tx = await buildCollectTx({ userAddress: ctx.conversation.wallet!, tokenId });
      const intent = ctx.intents.create({
        kind: "lp-collect",
        userAddress: ctx.conversation.wallet!,
        txs: [tx],
        summary: { tokenId: String(tokenId), position: pos },
        risks: ["收取手续费不会移除本金，但需用户自行签名。"],
      });
      ctx.conversations.consumeConfirm(ctx.conversation.id);
      ctx.conversations.clearPending(ctx.conversation.id);
      ctx.conversation.userConfirmed = false;
      const signerUrl = `${ctx.signerWebUrl}/t/${intent.id}`;
      rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-collect", signerUrl, summary: { tokenId: String(tokenId) } });
      return JSON.stringify({ intentId: intent.id, signerUrl });
    }
    if (!args.amountTokenUi) throw new Error("amountTokenUi required for mint");
    const built = await buildMintLpTxs({
      userAddress: ctx.conversation.wallet!,
      token: String(args.token),
      amountTokenUi: String(args.amountTokenUi),
      amountQuoteUi: args.amountQuoteUi ? String(args.amountQuoteUi) : undefined,
      slippageBps: cfg.defaultSlippageBps,
      deadlineSeconds: cfg.deadlineSeconds,
      client,
    });
    const verdict = riskFor({
      tokenIn: String(args.token),
      tokenOut: "USDT",
      slippageBps: cfg.defaultSlippageBps,
      notionalUsd: Number(args.amountQuoteUi ?? 0),
      poolLiquidityUsd: Number(built.analysis.tvlUsdApprox) || 50_000,
      amountMin: built.amount0Min,
      state: ctx.conversation,
    });
    if (!verdict.ok) return JSON.stringify({ error: "risk_blocked", blockers: verdict.blockers });
    const intent = ctx.intents.create({
      kind: "lp-mint",
      userAddress: ctx.conversation.wallet!,
      txs: built.txs,
      summary: {
        analysis: built.analysis,
        ticks: built.ticks,
        amount0Desired: built.amount0Desired.toString(),
        amount1Desired: built.amount1Desired.toString(),
        amount0Min: built.amount0Min.toString(),
        amount1Min: built.amount1Min.toString(),
      },
      risks: [...verdict.warnings, ...built.analysis.warnings],
    });
    ctx.conversations.consumeConfirm(ctx.conversation.id);
    ctx.conversations.clearPending(ctx.conversation.id);
    delete ctx.conversation.lastLp;
    ctx.conversation.userConfirmed = false;
    const signerUrl = `${ctx.signerWebUrl}/t/${intent.id}`;
    rememberCreatedIntent(ctx, { id: intent.id, kind: "lp-mint", signerUrl, summary: intent.summary });
    return JSON.stringify({ intentId: intent.id, signerUrl });
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
    const report = buildDeliveryReport({
      title: String(args.title ?? "bStocks / Pancake V3 交付报告"),
      userAddress: ctx.conversation.wallet,
      orderId: ctx.conversation.lastOrderId,
      txs: (args.txs ?? []) as Array<{ kind: string; hash: string; note?: string }>,
      notes: (args.notes ?? ["由 Agent 根据本轮对话生成。"]) as string[],
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

  if (name === "read_balance") {
    const token = getToken(String(args.token));
    const account = getAddress(String(args.account)) as Address;
    return JSON.stringify(await readBalanceUi(client, token, account));
  }

  throw new Error(`Unknown tool ${name}`);
}
