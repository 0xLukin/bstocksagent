import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi, permit2Abi, smartRouterAbi, wbnbAbi } from "./abis.js";
import { getPublicClient } from "./client.js";
import { getToken, pancakeFromConfig } from "./registry.js";
import { quoteSwap, type QuoteArgs } from "./quote.js";
import { isAllowanceSimError } from "./simulate.js";
import { applySlippage, encodeV3Path } from "./ticks.js";
import type { PreparedTx, SwapQuote } from "./types.js";

export type BuildSwapArgs = QuoteArgs & {
  recipient: Address;
  slippageBps: number;
  deadlineSeconds: number;
};

export function boundedApproveTx(token: Address, spender: Address, rawAmount: bigint): PreparedTx {
  if (rawAmount <= 0n) throw new Error("approve amount must be > 0 (bounded approve)");
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, rawAmount],
    }),
    value: 0n,
    label: `approve ${rawAmount.toString()} raw to ${spender}`,
  };
}

export async function currentAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function readPermit2Allowance(
  client: PublicClient,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<{ amount: bigint; expiration: number }> {
  const [amount, expiration] = await client.readContract({
    address: pancakeFromConfig().permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender],
  });
  return { amount: BigInt(amount), expiration: Number(expiration) };
}

export function pathFromHops(hops: SwapQuote["hops"]): Hex {
  if (hops.length < 1) throw new Error("swap path needs at least one hop");
  const parts: Array<{ token: Address; fee?: number }> = hops.map((hop) => ({
    token: getToken(hop.tokenIn).address,
    fee: hop.fee,
  }));
  parts.push({ token: getToken(hops[hops.length - 1]!.tokenOut).address });
  return encodeV3Path(parts);
}

export function planSwapPayments(
  quote: SwapQuote,
  allowance: bigint,
): { needsApprove: boolean; value: bigint } {
  return {
    needsApprove: !quote.nativeIn && allowance < quote.amountInRaw,
    value: quote.nativeIn ? quote.amountInRaw : 0n,
  };
}

function encodeSwapCall(quote: SwapQuote, recipient: Address, amountOutMin: bigint): Hex {
  if (quote.route === "v3-single") {
    return encodeFunctionData({
      abi: smartRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: quote.tokenIn.address,
          tokenOut: quote.tokenOut.address,
          fee: quote.fee,
          recipient,
          amountIn: quote.amountInRaw,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }
  return encodeFunctionData({
    abi: smartRouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: pathFromHops(quote.hops),
        recipient,
        amountIn: quote.amountInRaw,
        amountOutMinimum: amountOutMin,
      },
    ],
  });
}

function encodeRouterCalls(
  quote: SwapQuote,
  user: Address,
  amountOutMin: bigint,
  routerNativeIn: boolean,
): Hex[] {
  const pancake = pancakeFromConfig();
  const swapRecipient = quote.nativeOut ? pancake.smartRouter : user;
  const calls = [encodeSwapCall(quote, swapRecipient, amountOutMin)];
  if (quote.nativeOut) {
    calls.push(
      encodeFunctionData({
        abi: smartRouterAbi,
        functionName: "unwrapWETH9",
        args: [amountOutMin, user],
      }),
    );
  }
  if (routerNativeIn) {
    calls.push(encodeFunctionData({ abi: smartRouterAbi, functionName: "refundETH" }));
  }
  return calls;
}

async function routerConsumesNative(
  client: PublicClient,
  account: Address,
  router: Address,
  data: Hex,
  value: bigint,
): Promise<boolean> {
  try {
    await client.call({ account, to: router, data, value });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAllowanceSimError(message)) return false;
    if (/Not WETH9|cannot receive|native|payable/i.test(message)) return false;
    return true;
  }
}

export async function buildSwapTxs(args: BuildSwapArgs): Promise<{
  quote: SwapQuote;
  amountOutMin: bigint;
  txs: PreparedTx[];
  deadline: bigint;
  notes: string[];
}> {
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0 (amountMin != 0)");
  const client = args.client ?? getPublicClient();
  const quote = await quoteSwap(args);
  const amountOutMin = applySlippage(quote.amountOutRaw, args.slippageBps, "minOut");
  if (amountOutMin <= 0n) throw new Error("amountOutMinimum would be 0 — refusing");

  const pancake = pancakeFromConfig();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);
  const notes: string[] = [];

  if (!quote.nativeIn) {
    try {
      const leftover = await readPermit2Allowance(
        client,
        args.recipient,
        quote.tokenIn.address,
        pancake.smartRouter,
      );
      const now = Math.floor(Date.now() / 1000);
      if (leftover.amount >= quote.amountInRaw && leftover.expiration > now) {
        notes.push(
          "Permit2 already has a Smart Router allowance, but 0x13f4 still uses ERC20 transferFrom. Keep a bounded Router approve.",
        );
      }
    } catch {
      /* Permit2 read is informational */
    }
  }

  let routerNativeIn = quote.nativeIn;
  let swapData = encodeFunctionData({
    abi: smartRouterAbi,
    functionName: "multicall",
    args: [deadline, encodeRouterCalls(quote, args.recipient, amountOutMin, routerNativeIn)],
  });

  if (quote.nativeIn) {
    const ok = await routerConsumesNative(
      client,
      args.recipient,
      pancake.smartRouter,
      swapData,
      quote.amountInRaw,
    );
    if (!ok) {
      routerNativeIn = false;
      swapData = encodeFunctionData({
        abi: smartRouterAbi,
        functionName: "multicall",
        args: [deadline, encodeRouterCalls(quote, args.recipient, amountOutMin, false)],
      });
      notes.push("Smart Router did not consume msg.value. Wrap to WBNB first, then swap.");
    }
  }

  const txs: PreparedTx[] = [];
  if (quote.nativeIn && !routerNativeIn) {
    txs.push({
      to: quote.tokenIn.address,
      data: encodeFunctionData({ abi: wbnbAbi, functionName: "deposit" }),
      value: quote.amountInRaw,
      label: "wrap native BNB → WBNB",
    });
  }

  const allowance = quote.nativeIn && routerNativeIn
    ? quote.amountInRaw
    : await currentAllowance(client, quote.tokenIn.address, args.recipient, pancake.smartRouter);
  const pay = planSwapPayments(
    { ...quote, nativeIn: quote.nativeIn && routerNativeIn },
    allowance,
  );
  if (pay.needsApprove || (quote.nativeIn && !routerNativeIn && allowance < quote.amountInRaw)) {
    txs.push(boundedApproveTx(quote.tokenIn.address, pancake.smartRouter, quote.amountInRaw));
  }

  const inLabel = quote.nativeIn ? "BNB" : quote.tokenIn.symbol;
  const outLabel = quote.nativeOut ? "BNB" : quote.tokenOut.symbol;
  txs.push({
    to: pancake.smartRouter,
    data: swapData,
    value: routerNativeIn ? quote.amountInRaw : 0n,
    label: `swap ${inLabel}→${outLabel} via ${quote.route}`,
  });

  return { quote, amountOutMin, txs, deadline, notes };
}
