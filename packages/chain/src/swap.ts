import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { erc20Abi, smartRouterAbi } from "./abis.js";
import { getPublicClient } from "./client.js";
import { getToken, pancakeFromConfig } from "./registry.js";
import { quoteSwap, type QuoteArgs } from "./quote.js";
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

function encodeSwapCall(quote: SwapQuote, recipient: Address, amountOutMin: bigint): `0x${string}` {
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
  const wbnb = getToken("WBNB").address;
  const path = encodeV3Path([
    { token: quote.tokenIn.address, fee: quote.hops[0]!.fee },
    { token: wbnb, fee: quote.hops[1]!.fee },
    { token: quote.tokenOut.address },
  ]);
  return encodeFunctionData({
    abi: smartRouterAbi,
    functionName: "exactInput",
    args: [
      {
        path,
        recipient,
        amountIn: quote.amountInRaw,
        amountOutMinimum: amountOutMin,
      },
    ],
  });
}

export async function buildSwapTxs(args: BuildSwapArgs): Promise<{
  quote: SwapQuote;
  amountOutMin: bigint;
  txs: PreparedTx[];
  deadline: bigint;
}> {
  if (args.slippageBps <= 0) throw new Error("slippageBps must be > 0 (amountMin != 0)");
  const client = args.client ?? getPublicClient();
  const quote = await quoteSwap(args);
  const amountOutMin = applySlippage(quote.amountOutRaw, args.slippageBps, "minOut");
  if (amountOutMin <= 0n) throw new Error("amountOutMinimum would be 0 — refusing");

  const pancake = pancakeFromConfig();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds);
  const swapData = encodeSwapCall(quote, args.recipient, amountOutMin);
  const multicall = encodeFunctionData({
    abi: smartRouterAbi,
    functionName: "multicall",
    args: [deadline, [swapData]],
  });

  const txs: PreparedTx[] = [];
  const allowance = await currentAllowance(
    client,
    quote.tokenIn.address,
    args.recipient,
    pancake.smartRouter,
  );
  if (allowance < quote.amountInRaw) {
    txs.push(boundedApproveTx(quote.tokenIn.address, pancake.smartRouter, quote.amountInRaw));
  }
  txs.push({
    to: pancake.smartRouter,
    data: multicall,
    value: 0n,
    label: `swap ${quote.tokenIn.symbol}→${quote.tokenOut.symbol} via ${quote.route}`,
  });

  return { quote, amountOutMin, txs, deadline };
}
