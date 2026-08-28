import { type Address, type Hex, type PublicClient } from "viem";

export type SimTx = {
  to: Address;
  data: Hex;
  value: bigint | string;
  label?: string;
};

export type SimResult = {
  ok: boolean;
  hardFail: boolean;
  gasLimit: bigint;
  gasFeeWei: bigint;
  notes: string[];
};

export function isAllowanceSimError(message: string): boolean {
  return /insufficient allowance|transfer amount exceeds allowance|TRANSFER_FROM|ERC20: transfer|allowance/i.test(
    message,
  );
}

export function fallbackGasLimit(label: string | undefined): bigint {
  const text = label ?? "";
  if (/approve/i.test(text)) return 80_000n;
  if (/wrap|unwrap|deposit|withdraw/i.test(text)) return 50_000n;
  if (/mint|increase/i.test(text)) return 650_000n;
  if (/decrease|collect|burn/i.test(text)) return 250_000n;
  return 400_000n;
}

function hasPriorApprove(txs: SimTx[], index: number): boolean {
  return txs.slice(0, index).some((tx) => /approve/i.test(tx.label ?? ""));
}

function txValue(tx: SimTx): bigint {
  return typeof tx.value === "bigint" ? tx.value : BigInt(tx.value || "0");
}

/**
 * eth_call each tx from `account`. Sequential approve+swap cannot persist
 * allowance on a public RPC, so an allowance revert after a prior approve
 * is treated as a soft note (conservative gas), not a hard fail.
 */
export async function simulatePreparedTxs(
  client: PublicClient,
  account: Address,
  txs: SimTx[],
): Promise<SimResult> {
  const notes: string[] = [];
  let gasLimit = 0n;
  let hardFail = false;

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const request = {
      account,
      to: tx.to,
      data: tx.data,
      value: txValue(tx),
    };
    try {
      await client.call(request);
      const gas = await client.estimateGas(request);
      gasLimit += gas;
      notes.push(`Tx ${i + 1} simulated, ~${gas.toString()} gas`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pendingApprove =
        hasPriorApprove(txs, i) && (isAllowanceSimError(message) || /\bSTF\b/i.test(message));
      if (pendingApprove) {
        const guess = fallbackGasLimit(tx.label);
        gasLimit += guess;
        notes.push(`Tx ${i + 1} needs the prior approve on-chain first; estimating ${guess.toString()} gas`);
        continue;
      }
      if (/approve/i.test(tx.label ?? "") && (isAllowanceSimError(message) || /execution reverted/i.test(message))) {
        const guess = fallbackGasLimit(tx.label);
        gasLimit += guess;
        notes.push(`Tx ${i + 1} approve could not be simulated exactly; estimating ${guess.toString()} gas`);
        continue;
      }
      hardFail = true;
      notes.push(`Tx ${i + 1} simulation failed: ${message.slice(0, 240)}`);
      break;
    }
  }

  let gasFeeWei = 0n;
  if (gasLimit > 0n) {
    try {
      gasFeeWei = gasLimit * (await client.getGasPrice());
    } catch (err) {
      notes.push(`Failed to read gasPrice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: !hardFail,
    hardFail,
    gasLimit,
    gasFeeWei,
    notes,
  };
}
