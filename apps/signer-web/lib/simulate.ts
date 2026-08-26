import { formatEther, type Address, type Hex, type PublicClient } from "viem";

export type SimTx = {
  to: Address;
  data: Hex;
  value: string;
  label?: string;
};

export type LiveSim = {
  status: "running" | "ok" | "fail" | "warn";
  gasBnb?: string;
  notes: string[];
  error?: string;
};

const ALLOWANCE_RE =
  /allowance|STF|TRANSFER_FROM|transfer amount exceeds|insufficient allowance|ERC20: transfer/i;

function fallbackGasLimit(label: string | undefined): bigint {
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

export async function simulateIntentTxs(
  client: PublicClient,
  account: Address,
  txs: SimTx[],
): Promise<LiveSim> {
  const notes: string[] = [];
  let gasLimit = 0n;

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const request = {
      account,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value || "0"),
    };
    try {
      await client.call(request);
      const gas = await client.estimateGas(request);
      gasLimit += gas;
      notes.push(`第 ${i + 1} 笔模拟通过`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pendingApprove = hasPriorApprove(txs, i) && ALLOWANCE_RE.test(message);
      if (pendingApprove || (/approve/i.test(tx.label ?? "") && ALLOWANCE_RE.test(message))) {
        gasLimit += fallbackGasLimit(tx.label);
        notes.push(`第 ${i + 1} 笔需等授权上链，已按同类交易估 gas`);
        continue;
      }
      return {
        status: "fail",
        notes,
        error: `第 ${i + 1} 笔模拟失败：${message.split("\n")[0]!.slice(0, 160)}`,
      };
    }
  }

  let gasBnb: string | undefined;
  try {
    if (gasLimit > 0n) {
      gasBnb = formatEther(gasLimit * (await client.getGasPrice()));
    }
  } catch (err) {
    notes.push(`gasPrice 读取失败：${err instanceof Error ? err.message : String(err)}`);
    return { status: "warn", notes, gasBnb };
  }

  return { status: "ok", gasBnb, notes };
}
