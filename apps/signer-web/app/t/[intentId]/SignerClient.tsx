"use client";

import { useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";
import { bsc } from "wagmi/chains";
import { buildIntentView, remainingLabel, shortAddr, txTitle, wantsLpFollowUp } from "../../../lib/intentView";
import { cancelIntent, fetchIntent, reportTx, type RemoteIntent } from "../../../lib/runtime";
import { simulateIntentTxs, type LiveSim } from "../../../lib/simulate";

function hashesReady(intent: RemoteIntent, log: string[]) {
  const n = new Set([...log, ...intent.txHashes]).size;
  return n >= intent.txs.length;
}

export function SignerClient({ intentId }: { intentId: string }) {
  const [intent, setIntent] = useState<RemoteIntent | null>(null);
  const [error, setError] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [followUpUrl, setFollowUpUrl] = useState("");
  const [followUpError, setFollowUpError] = useState("");
  const [settledNote, setSettledNote] = useState("");
  const [sim, setSim] = useState<LiveSim>({ status: "running", notes: [] });
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: 56 });

  useEffect(() => {
    fetchIntent(intentId)
      .then(setIntent)
      .catch((e: Error) => setError(e.message));
  }, [intentId]);

  const view = useMemo(() => (intent ? buildIntentView(intent) : null), [intent]);
  const ttl = intent ? remainingLabel(intent.expiresAt) : null;
  const twoStep = Boolean(intent && wantsLpFollowUp(intent));
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

  const cancelled = Boolean(intent?.cancelledAt);
  const fullyBroadcast = Boolean(intent && intent.txs.length > 0 && hashesReady(intent, log));

  useEffect(() => {
    if (!intent || !fullyBroadcast || cancelled) return;
    if (!twoStep) return;
    if (intent.followUpSignerUrl) {
      setFollowUpUrl(intent.followUpSignerUrl);
      return;
    }
    let stop = false;
    let n = 0;
    const tick = () => {
      if (stop) return;
      void fetchIntent(intentId)
        .then((latest) => {
          if (stop) return;
          if (latest.followUpSignerUrl) {
            setFollowUpUrl(latest.followUpSignerUrl);
            setFollowUpError("");
            return;
          }
          if (latest.followUpError) {
            setFollowUpError(latest.followUpError);
            return;
          }
          n += 1;
          if (n < 45) window.setTimeout(tick, 2000);
        })
        .catch((e: Error) => {
          if (!stop) setFollowUpError(e.message);
        });
    };
    tick();
    return () => {
      stop = true;
    };
  }, [fullyBroadcast, cancelled, intent, intentId, twoStep]);

  useEffect(() => {
    if (!intent || !fullyBroadcast || cancelled) return;
    if (!intent.kind.startsWith("lp")) return;
    if (intent.settledNote) {
      setSettledNote(intent.settledNote);
      return;
    }
    let stop = false;
    let n = 0;
    const tick = () => {
      if (stop) return;
      void fetchIntent(intentId)
        .then((latest) => {
          if (stop) return;
          if (latest.settledNote) {
            setSettledNote(latest.settledNote);
            return;
          }
          n += 1;
          if (n < 30) window.setTimeout(tick, 2000);
        })
        .catch(() => {
          /* agent will still pick up via 签完了 */
        });
    };
    tick();
    return () => {
      stop = true;
    };
  }, [fullyBroadcast, cancelled, intent, intentId]);

  useEffect(() => {
    if (!intent || intent.cancelledAt) return;
    if (intent.txHashes.length > 0) {
      setSim({ status: "ok", notes: [] });
      return;
    }
    const expired = Date.parse(intent.expiresAt) <= Date.now();
    if (expired) {
      setSim({
        status: "warn",
        notes: [],
        error: "签名页已过期。不要签这一页。回聊天再说「确认」，会重新出页。",
      });
      return;
    }
    if (!publicClient) {
      setSim({ status: "warn", notes: [], error: "连不上 BSC，没法预先模拟。请自己看钱包弹窗里的数量。" });
      return;
    }
    const from = address && boundOk ? address : intent.userAddress;
    let cancelledSim = false;
    setSim({ status: "running", notes: [] });
    simulateIntentTxs(publicClient, from, intent.txs)
      .then((next) => {
        if (!cancelledSim) setSim(next);
      })
      .catch((e: Error) => {
        if (!cancelledSim) {
          setSim({
            status: "warn",
            notes: [],
            error: `无法模拟：${e.message}`,
          });
        }
      });
    return () => {
      cancelledSim = true;
    };
  }, [intent, publicClient, address, boundOk]);

  async function onSign() {
    if (!intent || !address) return;
    if (!boundOk) {
      setError("请先切换到绑定钱包再签名。");
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
    return (
      <section className="ticket">
        <p className="banner danger">{error}</p>
        <p className="muted">确认 Runtime 已启动，并且链接没有过期。</p>
      </section>
    );
  }
  if (!intent || !view || !ttl) {
    return (
      <section className="ticket ticket-loading">
        <p className="eyebrow">bStocks</p>
        <h1>正在打开签名页</h1>
        <p className="muted">核对绑定钱包和数量之后再签。</p>
      </section>
    );
  }

  const wrongWallet = isConnected && !boundOk;
  const wrongChain = Boolean(chainId && chainId !== 56);
  const simBlocked = sim.status === "fail";
  const canSign =
    boundOk &&
    !ttl.expired &&
    !sending &&
    !wrongChain &&
    !cancelled &&
    !fullyBroadcast &&
    !simBlocked &&
    sim.status !== "running";
  const hashes = [...new Set([...log, ...intent.txHashes])];
  const canCancel = !cancelled && !fullyBroadcast && !sending;
  const statusKind = cancelled ? "cancelled" : fullyBroadcast ? "done" : ttl.expired ? "expired" : "live";
  const ttlText = cancelled
    ? "代币仍在钱包。回聊天重新报价即可。"
    : fullyBroadcast
      ? "已经广播。过期不影响这笔。"
      : ttl.text;

  return (
    <section className={`ticket ticket-${view.kind} ticket-${statusKind}`}>
      <header className="mast">
        <div className="mast-copy">
          <p className="eyebrow">
            bStocks · {cancelled ? "已取消" : view.eyebrow}
            <span className="dot">·</span>
            {ttlText}
          </p>
          <h1>{cancelled ? "不会广播" : view.title}</h1>
        </div>
        <span className="chip">BNB Chain</span>
      </header>

      {view.stepLabel && !fullyBroadcast && !cancelled && <p className="step-callout">{view.stepLabel}</p>}

      <div className="legs" aria-label={`${view.payLabel}，${view.getLabel}`}>
        <div className="leg pay">
          <div className="leg-kicker">{view.payLabel}</div>
          <div className="amt">
            {view.payAmount} <span className="sym">{view.paySymbol}</span>
          </div>
          {view.payName && view.payName !== view.paySymbol && <span className="hint"> {view.payName}</span>}
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="leg get">
          <div className="leg-kicker">{view.getLabel}</div>
          <div className="amt">
            {view.getAmount} <span className="sym">{view.getSymbol}</span>
          </div>
          {view.getName && view.getName !== view.getSymbol && <span className="hint"> {view.getName}</span>}
        </div>
      </div>

      {(view.minGet || view.slippage || view.detail || sim.gasBnb || sim.status === "running") && (
        <p className="facts">
          {view.minGet && (
            <span>
              最少 {view.minGet} {view.getSymbol}
            </span>
          )}
          {view.slippage && <span>滑点 {view.slippage}</span>}
          {view.detail && <span>{view.detail}</span>}
          {sim.status === "ok" && sim.gasBnb && <span>矿工费约 {Number(sim.gasBnb).toPrecision(3)} BNB</span>}
          {sim.status === "running" && <span>正在估算 gas…</span>}
        </p>
      )}

      <p className="footnote">{view.footnote}</p>

      {sim.status === "warn" && <p className="banner warn">{sim.error ?? "模拟不完整。请自己核对钱包弹窗。"}</p>}
      {sim.status === "fail" && <p className="banner danger">{sim.error ?? "模拟失败，已禁止签名。"}</p>}

      <div className="wallet-row">
        <div className="wallet-copy">
          <span className="wallet-addr">{shortAddr(intent.userAddress)}</span>
          <span className="hint">
            {fullyBroadcast
              ? "已由绑定钱包签过"
              : isConnected && address
                ? boundOk
                  ? `已连接 ${shortAddr(address)}`
                  : `连着 ${shortAddr(address)}，对不上`
                : "未连接 · 必须用这个地址"}
          </span>
        </div>
        {!fullyBroadcast &&
          (isConnected ? (
            <button type="button" className="ghost" onClick={() => disconnect()}>
              断开
            </button>
          ) : (
            <button type="button" className="ghost" disabled={isPending} onClick={connectWallet}>
              {isPending ? "连接中…" : "连接"}
            </button>
          ))}
      </div>

      {wrongWallet && <p className="banner warn">连上的不是绑定地址，无法签名。请在钱包里切换账号。</p>}
      {wrongChain && (
        <p className="banner warn">
          当前不是 BNB Chain。
          <button type="button" className="linkish" onClick={() => switchChain({ chainId: 56 })}>
            切换到 BSC
          </button>
        </p>
      )}
      {cancelled && <p className="banner warn">已取消。回聊天重新说要买/卖/组 LP 即可。</p>}
      {ttl.expired && !cancelled && !fullyBroadcast && <p className="banner warn">已过期。回聊天再说「确认」，会重新出页。</p>}
      {error && <p className="banner danger">{error}</p>}

      {!cancelled && !fullyBroadcast && (
        <div className="actions">
          {!isConnected ? (
            <button className="primary" disabled={isPending || ttl.expired} onClick={connectWallet}>
              {isPending ? "等待钱包…" : "连接钱包后签名"}
            </button>
          ) : (
            <button className="primary" disabled={!canSign} onClick={() => void onSign()}>
              {sending ? "等待钱包确认…" : sim.status === "running" ? "模拟中…" : view.cta}
            </button>
          )}
          <button className="ghost cancel" disabled={!canCancel || cancelling} onClick={() => void onCancel()}>
            {cancelling ? "取消中…" : "取消"}
          </button>
        </div>
      )}

      {fullyBroadcast && !cancelled && (
        <div className="done">
          <p className="done-title">{settledNote || view.doneTitle}</p>
          <p className="muted">{view.doneBody}</p>
          {hashes.length > 0 && (
            <div className="hashes">
              {hashes.map((h) => (
                <a key={h} href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
                  {shortAddr(h)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {hashes.length > 0 && !fullyBroadcast && (
        <div className="hashes">
          {hashes.map((h) => (
            <a key={h} href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
              {shortAddr(h)}
            </a>
          ))}
        </div>
      )}

      {followUpError && twoStep && <p className="banner warn">{followUpError}</p>}
      {followUpUrl && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            window.location.href = followUpUrl;
          }}
        >
          兑换已完成。打开下一步：组 LP
        </button>
      )}

      <details className="advanced">
        <summary>更多核对（raw、交易、风险）</summary>
        <dl className="kv">
          {typeof intent.summary.amountInRaw === "string" && (
            <>
              <dt>支付 raw</dt>
              <dd>
                <code>{intent.summary.amountInRaw}</code>
              </dd>
            </>
          )}
          {typeof intent.summary.amountOutRaw === "string" && (
            <>
              <dt>获得 raw</dt>
              <dd>
                <code>{intent.summary.amountOutRaw}</code>
              </dd>
            </>
          )}
          {typeof intent.summary.amountOutMin === "string" && (
            <>
              <dt>最少获得 raw</dt>
              <dd>
                <code>{intent.summary.amountOutMin}</code>
              </dd>
            </>
          )}
        </dl>
        <p className="hint">链上只认 raw。上面的股数是按证书倍率换算后给人看的。</p>
        <p className="hint">{fullyBroadcast ? "已广播的交易" : `将广播 ${intent.txs.length} 笔`}</p>
        <ol className="tx-list">
          {intent.txs.map((tx, i) => (
            <li key={i}>
              <div className="tx-title">
                {i + 1}. {txTitle(tx.label)}
              </div>
              <div className="hint">
                发往 <code>{shortAddr(tx.to)}</code>
              </div>
              <code className="calldata">{tx.data.slice(0, 22)}…</code>
            </li>
          ))}
        </ol>
        <p className="hint">
          {sim.status === "ok"
            ? "链上模拟已通过。"
            : sim.status === "fail"
              ? "链上模拟失败，不要签。"
              : intent.simulation.ok
                ? "调用已编码。本页会再模拟一次。"
                : "编码检查未通过。"}
        </p>
        {sim.notes.length > 0 && (
          <ul className="risks">
            {sim.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {intent.risks.length > 0 && (
          <ul className="risks">
            {intent.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
