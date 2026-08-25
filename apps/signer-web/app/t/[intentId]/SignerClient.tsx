"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { useAccount, useConnect, useDisconnect, useSendTransaction, useSwitchChain } from "wagmi";
import { bsc } from "wagmi/chains";
import { buildIntentView, remainingLabel, shortAddr, txTitle } from "../../../lib/intentView";
import { cancelIntent, fetchIntent, reportTx, type RemoteIntent } from "../../../lib/runtime";

function hashesReady(intent: RemoteIntent, log: string[]) {
  const n = new Set([...log, ...intent.txHashes]).size;
  return n >= intent.txs.length;
}

export function SignerClient({ intentId }: { intentId: string }) {
  const [intent, setIntent] = useState<RemoteIntent | null>(null);
  const [error, setError] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
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

  const view = useMemo(() => (intent ? buildIntentView(intent) : null), [intent]);
  const ttl = intent ? remainingLabel(intent.expiresAt) : null;
  const boundOk = useMemo(() => {
    if (!intent || !address) return false;
    try {
      return getAddress(address) === getAddress(intent.userAddress);
    } catch {
      return false;
    }
  }, [intent, address]);

  useEffect(() => {
    if (view) document.title = view.title;
  }, [view]);

  async function onSign() {
    if (!intent || !address) return;
    if (!boundOk) {
      setError("请切换到绑定钱包后再签。");
      return;
    }
    if (chainId !== 56) {
      await switchChain({ chainId: 56 });
    }
    try {
      for (const tx of intent.txs) {
        const hash = await sendTransactionAsync({
          chainId: 56,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value || "0"),
        });
        setLog((l) => [...l, hash]);
        await reportTx(intent.id, hash, address);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCancel() {
    if (!intent) return;
    setError("");
    setCancelling(true);
    try {
      setIntent(await cancelIntent(intent.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }

  function connectWallet() {
    const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (injected) connect({ connector: injected, chainId: bsc.id });
  }

  if (error && !intent) {
    return <div className="card danger">{error}</div>;
  }
  if (!intent || !view || !ttl) {
    return <div className="card muted">正在读取这笔意图…</div>;
  }

  const cancelled = Boolean(intent.cancelledAt);
  const fullyBroadcast = intent.txs.length > 0 && hashesReady(intent, log);
  const wrongWallet = isConnected && !boundOk;
  const wrongChain = Boolean(chainId && chainId !== 56);
  const canSign = boundOk && !ttl.expired && !sending && !wrongChain && !cancelled && !fullyBroadcast;
  const hashes = [...new Set([...log, ...intent.txHashes])];
  const canCancel = !cancelled && !fullyBroadcast && !sending;

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h1>{cancelled ? "已取消" : view.title}</h1>
          <p className="muted tight">{cancelled ? "不会再广播" : ttl.text}</p>
        </div>
        <span className="chip">BNB Chain</span>
      </div>

      <div className="exchange" aria-label="付出与得到">
        <div className="leg">
          <div className="leg-kicker">付出</div>
          <div className="amt">{view.payAmount}</div>
          <div className="sym">{view.paySymbol}</div>
          {view.payName && view.payName !== view.paySymbol && <div className="hint">{view.payName}</div>}
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="leg">
          <div className="leg-kicker">得到</div>
          <div className="amt get">{view.getAmount}</div>
          <div className="sym">{view.getSymbol}</div>
          {view.getName && view.getName !== view.getSymbol && <div className="hint">{view.getName}</div>}
        </div>
      </div>

      {view.detail && <p className="guard">{view.detail}</p>}
      {(view.minGet || view.slippage) && !view.detail && (
        <p className="guard">
          {view.minGet && (
            <>
              最少到手 <strong>{view.minGet} {view.getSymbol}</strong>
            </>
          )}
          {view.minGet && view.slippage && " · "}
          {view.slippage && <>滑点 {view.slippage}</>}
        </p>
      )}

      <p className="footnote">{view.footnote} 不构成投资建议。</p>

      <div className="wallet-row">
        <div>
          <div className="leg-kicker">钱包</div>
          <div className="wallet-addr">
            {isConnected && address ? shortAddr(address) : "未连接"}
          </div>
          <div className="hint">须为 {shortAddr(intent.userAddress)}</div>
        </div>
        {isConnected ? (
          <button type="button" className="ghost" onClick={() => disconnect()}>
            断开
          </button>
        ) : (
          <button type="button" className="ghost" disabled={isPending} onClick={connectWallet}>
            {isPending ? "连接中…" : "连接钱包"}
          </button>
        )}
      </div>

      {wrongWallet && <p className="banner warn">连的不是绑定地址，无法签名。</p>}
      {wrongChain && (
        <p className="banner warn">
          当前不是 BNB Chain。
          <button type="button" className="linkish" onClick={() => switchChain({ chainId: 56 })}>
            切换网络
          </button>
        </p>
      )}
      {cancelled && <p className="banner warn">这笔已取消，币还在你钱包里。回对话重新报价即可。</p>}
      {ttl.expired && !cancelled && <p className="banner warn">意图已过期，回对话让 Agent 再报一次价。</p>}
      {error && <p className="banner danger">{error}</p>}

      {!cancelled && !fullyBroadcast && (
        <>
          {!isConnected ? (
            <button className="primary" disabled={isPending || ttl.expired} onClick={connectWallet}>
              {isPending ? "等待钱包…" : "连接钱包后确认"}
            </button>
          ) : (
            <button className="primary" disabled={!canSign} onClick={() => void onSign()}>
              {sending ? "等待钱包确认…" : view.cta}
            </button>
          )}
          <button className="ghost cancel" disabled={!canCancel || cancelling} onClick={() => void onCancel()}>
            {cancelling ? "正在取消…" : "取消这笔"}
          </button>
        </>
      )}

      {hashes.length > 0 && (
        <div className="success">
          <div className="leg-kicker">已广播</div>
          {hashes.map((h) => (
            <a key={h} href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
              {shortAddr(h)}
            </a>
          ))}
        </div>
      )}

      <details className="advanced">
        <summary>raw 数量</summary>
        <dl className="kv">
          {typeof intent.summary.amountInRaw === "string" && (
            <>
              <dt>付出 raw</dt>
              <dd>
                <code>{intent.summary.amountInRaw}</code>
              </dd>
            </>
          )}
          {typeof intent.summary.amountOutRaw === "string" && (
            <>
              <dt>得到 raw</dt>
              <dd>
                <code>{intent.summary.amountOutRaw}</code>
              </dd>
            </>
          )}
          {typeof intent.summary.amountOutMin === "string" && (
            <>
              <dt>amountOutMin</dt>
              <dd>
                <code>{intent.summary.amountOutMin}</code>
              </dd>
            </>
          )}
        </dl>
        <p className="hint">链上只认 raw。上面的股数仅供阅读。</p>
      </details>

      <details className="advanced">
        <summary>将广播的交易（{intent.txs.length} 笔）</summary>
        <ol className="tx-list">
          {intent.txs.map((tx, i) => (
            <li key={i}>
              <div className="tx-title">
                {i + 1}. {txTitle(tx.label)}
              </div>
              <div className="hint">
                至 <code>{shortAddr(tx.to)}</code>
              </div>
              <code className="calldata">{tx.data.slice(0, 22)}…</code>
            </li>
          ))}
        </ol>
        <p className="hint">{intent.simulation.ok ? "编码检查通过。" : "编码检查未通过。"}</p>
      </details>

      {intent.risks.length > 0 && (
        <details className="advanced">
          <summary>风险说明</summary>
          <ul className="risks">
            {intent.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
