#!/usr/bin/env node
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { assertBsc, getPublicClient } from "./client.js";
import { loadRepoEnv } from "./dotenv.js";
loadRepoEnv();
import { analyzeLp, buildCollectTx, buildMintLpTxs, readPosition } from "./lp.js";
import { quoteSwap } from "./quote.js";
import { listTokens } from "./registry.js";
import { buildSwapTxs } from "./swap.js";

function printJson(value: unknown) {
  console.log(
    JSON.stringify(
      value,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
}

function req(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== "string" || !v) {
    throw new Error(`Missing --${name}`);
  }
  return v;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      in: { type: "string" },
      out: { type: "string" },
      token: { type: "string" },
      quote: { type: "string" },
      amount: { type: "string" },
      "amount-quote": { type: "string" },
      user: { type: "string" },
      fee: { type: "string" },
      slippage: { type: "string" },
      deadline: { type: "string" },
      range: { type: "string" },
      "token-id": { type: "string" },
    },
  });

  const cmd = positionals[0];
  if (!cmd || cmd === "help") {
    console.log(`Usage:
  quote --in USDT --out NVDAB --amount 10
  swap-intent --in USDT --out NVDAB --amount 10 --user 0x... [--slippage 50]
  lp-intent --token NVDAB --amount 0.01 --user 0x... [--amount-quote 10]
  lp-intent --collect --token-id 123 --user 0x...
  tokens`);
    return;
  }

  if (cmd === "tokens") {
    printJson(listTokens().map((t) => ({ symbol: t.symbol, address: t.address, scaledUi: t.scaledUi })));
    return;
  }

  const client = getPublicClient();
  await assertBsc(client);
  const slippage = Number(values.slippage ?? "50");
  const deadline = Number(values.deadline ?? "180");
  const fee = values.fee ? Number(values.fee) : undefined;

  if (cmd === "quote") {
    const q = await quoteSwap({
      tokenIn: req(values, "in"),
      tokenOut: req(values, "out"),
      amountInUi: req(values, "amount"),
      fee,
      client,
    });
    printJson({
      route: q.route,
      hops: q.hops,
      fee: q.fee,
      pool: q.pool,
      amountInRaw: q.amountInRaw.toString(),
      amountOutRaw: q.amountOutRaw.toString(),
      amountInUi: q.amountInUi,
      amountOutUi: q.amountOutUi,
      note: "Contract calls must use raw amounts, never UI amounts.",
    });
    return;
  }

  if (cmd === "swap-intent") {
    const user = getAddress(req(values, "user"));
    const built = await buildSwapTxs({
      tokenIn: req(values, "in"),
      tokenOut: req(values, "out"),
      amountInUi: req(values, "amount"),
      fee,
      recipient: user,
      slippageBps: slippage,
      deadlineSeconds: deadline,
      client,
    });
    printJson({
      kind: "swap",
      userAddress: user,
      quote: {
        ...built.quote,
        amountInRaw: built.quote.amountInRaw.toString(),
        amountOutRaw: built.quote.amountOutRaw.toString(),
        sqrtPriceX96After: built.quote.sqrtPriceX96After?.toString(),
      },
      amountOutMin: built.amountOutMin.toString(),
      deadline: built.deadline.toString(),
      txs: built.txs.map((t) => ({ ...t, value: t.value.toString() })),
    });
    return;
  }

  if (cmd === "lp-intent") {
    const user = getAddress(req(values, "user"));
    if (values["token-id"]) {
      const tokenId = BigInt(values["token-id"]);
      const pos = await readPosition(tokenId, client);
      const tx = await buildCollectTx({ userAddress: user, tokenId });
      printJson({
        kind: "lp-collect",
        position: pos,
        txs: [{ ...tx, value: tx.value.toString() }],
      });
      return;
    }
    const built = await buildMintLpTxs({
      userAddress: user,
      token: req(values, "token"),
      quote: values.quote,
      fee,
      amountTokenUi: req(values, "amount"),
      amountQuoteUi: values["amount-quote"],
      rangeBps: values.range ? Number(values.range) : undefined,
      slippageBps: slippage,
      deadlineSeconds: deadline,
      client,
    });
    printJson({
      kind: "lp-mint",
      analysis: built.analysis,
      ticks: built.ticks,
      amount0Desired: built.amount0Desired.toString(),
      amount1Desired: built.amount1Desired.toString(),
      amount0Min: built.amount0Min.toString(),
      amount1Min: built.amount1Min.toString(),
      deadline: built.deadline.toString(),
      txs: built.txs.map((t) => ({ ...t, value: t.value.toString() })),
    });
    return;
  }

  if (cmd === "analyze-lp") {
    printJson(await analyzeLp({ token: req(values, "token"), quote: values.quote, fee, client }));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
