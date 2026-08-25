"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { useAccount, useConnect, useDisconnect, useSendTransaction, useSwitchChain } from "wagmi";
import { bsc } from "wagmi/chains";
import { fetchIntent, reportTx, type RemoteIntent } from "../../../lib/runtime";

export function SignerClient({ intentId }: { intentId: string }) {
  const [intent, setIntent] = useState<RemoteIntent | null>(null);
  const [error, setError] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();

  useEffect(() => {
    fetchIntent(intentId)
      .then(setIntent)
      .catch((e: Error) => setError(e.message));
  }, [intentId]);

  const boundOk = useMemo(() => {
    if (!intent || !address) return false;
    try {
      return getAddress(address) === getAddress(intent.userAddress);
    } catch {
      return false;
    }
  }, [intent, address]);

  const expired = intent ? Date.parse(intent.expiresAt) <= Date.now() : false;

  async function onSign() {
    if (!intent || !address) return;
    if (!boundOk) {
      setError("连接钱包与意图绑定地址不一致，已拒绝。");
      return;
    }
    if (chainId !== 56) {
      await switchChain({ chainId: 56 });
    }
    const hashes: string[] = [];
    try {
      for (const tx of intent.txs) {
        const hash = await sendTransactionAsync({
          chainId: 56,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value || "0"),
        });
        hashes.push(hash);
        setLog((l) => [...l, `${tx.label}: ${hash}`]);
        await reportTx(intent.id, hash, address);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error && !intent) {
    return <div className="card danger">{error}</div>;
  }
  if (!intent) return <div className="card muted">正在从 Runtime 读取意图…</div>;

  return (
    <>
      <div className="card">
        <h2>意图 {intent.kind}</h2>
        <div className="row">
          <span>绑定地址</span>
          <span>
            <code>{intent.userAddress}</code>
          </span>
        </div>
        <div className="row">
          <span>链</span>
          <span>BNB Chain ({intent.chainId})</span>
        </div>
        <div className="row">
          <span>过期</span>
          <span className={expired ? "danger" : ""}>{intent.expiresAt}</span>
        </div>
        {!isConnected ? (
          <button
            disabled={isPending}
            onClick={() => {
              const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
              if (injected) connect({ connector: injected, chainId: bsc.id });
            }}
          >
            连接钱包（仅 BSC）
          </button>
        ) : (
          <div className="row">
            <span>当前钱包</span>
            <span>
              <code>{address}</code>{" "}
              <button type="button" onClick={() => disconnect()}>
                断开
              </button>
            </span>
          </div>
        )}
        {isConnected && !boundOk && <p className="danger">钱包与绑定地址不符，不能签名。</p>}
        {chainId && chainId !== 56 && (
          <p className="danger">
            当前不是 BSC。
            <button type="button" onClick={() => switchChain({ chainId: 56 })}>
              切换到 BNB Chain
            </button>
          </p>
        )}
      </div>

      <div className="card">
        <h2>模拟与数量（raw vs UI）</h2>
        <p className="muted">
          {intent.simulation.ok ? "编码模拟通过。" : "模拟未通过。"} {intent.simulation.notes.join(" ")}
        </p>
        <pre>{JSON.stringify(intent.summary, null, 2)}</pre>
      </div>

      <div className="card">
        <h2>将广播的交易</h2>
        <ul className="muted">
          {intent.txs.map((tx, i) => (
            <li key={i}>
              {tx.label} → <code>{tx.to}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>风险</h2>
        <ul className="muted">
          {intent.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {error && <p className="danger">{error}</p>}
        <button disabled={!boundOk || expired || sending} onClick={() => void onSign()}>
          {sending ? "等待钱包…" : "用我的钱包广播"}
        </button>
        {log.length > 0 && (
          <ul className="ok">
            {log.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        {intent.txHashes.length > 0 && (
          <p className="muted">已回传 Runtime：{intent.txHashes.join(", ")}</p>
        )}
      </div>
    </>
  );
}
