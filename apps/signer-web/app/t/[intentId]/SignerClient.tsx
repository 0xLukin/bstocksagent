"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import {
  buildIntentView,
  remainingLabel,
  shortAddr,
  txTitle,
  wantsLpFollowUp,
  type IntentView,
} from "../../../lib/intentView";
import { connectErrorMessage, getInjectedProvider } from "../../../lib/injected";
import { cancelIntent, fetchIntent, reportTx, type RemoteIntent } from "../../../lib/runtime";
import { simulateIntentTxs, type LiveSim } from "../../../lib/simulate";

function hashesReady(intent: RemoteIntent, log: string[]) {
  const n = new Set([...log, ...intent.txHashes]).size;
  return n >= intent.txs.length;
}

function Leg({
  label,
  amount,
  symbol,
  sub,
  gain,
}: {
  label: string;
  amount: string;
  symbol: string;
  sub?: string;
  gain?: boolean;
}) {
  return (
    <div className="leg">
      <p className="leg-label">{label}</p>
      <div className={`leg-value${gain ? " gain" : ""}`}>
        {amount} {symbol ? <span className="sym">{symbol}</span> : null}
      </div>
      {sub ? <p className="leg-sub">{sub}</p> : null}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="meta-row">
      <div className="meta-k">{label}</div>
      <div className="meta-v">{children}</div>
    </div>
  );
}

function AmountLegs({
  left,
  right,
}: {
  left: { label: string; amount: string; symbol: string; sub?: string; gain?: boolean };
  right: { label: string; amount: string; symbol: string; sub?: string; gain?: boolean };
}) {
  return (
    <div className="legs" aria-label={`${left.label}，${right.label}`}>
      <Leg {...left} />
      <Leg {...right} />
    </div>
  );
}

function legsForView(view: IntentView, mode: "live" | "done") {
  if (view.side0 && view.side1) {
    const verb =
      mode === "done"
        ? view.kind === "lp-decrease" || view.kind === "lp-collect"
          ? "到账"
          : "放入"
        : view.kind === "lp-decrease" || view.kind === "lp-collect"
          ? "预计到账"
          : "放入";
    return {
      left: {
        label: `${verb} ${view.side0.symbol}`,
        amount: view.side0.amount,
        symbol: view.side0.symbol,
        sub: view.side0.name && view.side0.name !== view.side0.symbol ? view.side0.name : undefined,
        gain: true,
      },
      right: {
        label: `${verb} ${view.side1.symbol}`,
        amount: view.side1.amount,
        symbol: view.side1.symbol,
        sub: view.side1.name && view.side1.name !== view.side1.symbol ? view.side1.name : undefined,
        gain: true,
      },
    };
  }

  if (mode === "done") {
    return {
      left: {
        label: view.doneGetLabel,
        amount: view.getAmount,
        symbol: view.getSymbol,
        sub: view.getName && view.getName !== view.getSymbol ? view.getName : undefined,
        gain: true,
      },
      right: {
        label: view.donePayLabel,
        amount: view.payAmount,
        symbol: view.paySymbol,
        sub: view.payName && view.payName !== view.paySymbol ? view.payName : undefined,
      },
    };
  }

  return {
    left: {
      label: view.payLabel,
      amount: view.payAmount,
      symbol: view.paySymbol,
      sub: view.payName && view.payName !== view.paySymbol ? view.payName : undefined,
    },
    right: {
      label: view.getLabel,
      amount: view.getAmount,
      symbol: view.getSymbol,
      sub: view.getName && view.getName !== view.getSymbol ? view.getName : undefined,
      gain: true,
    },
  };
}

function ResultRaw({ intent, simOk }: { intent: RemoteIntent; simOk?: boolean }) {
  return (
    <div className="raw-body">
      <dl className="kv">
        {typeof intent.summary.amountInRaw === "string" && (
          <>
            <dt>支付</dt>
            <dd>
              <code>{intent.summary.amountInRaw}</code>
            </dd>
          </>
        )}
        {typeof intent.summary.amountOutRaw === "string" && (
          <>
            <dt>获得</dt>
            <dd>
              <code>{intent.summary.amountOutRaw}</code>
            </dd>
          </>
        )}
        {typeof intent.summary.amountOutMin === "string" && (
          <>
            <dt>最少</dt>
            <dd>
              <code>{intent.summary.amountOutMin}</code>
            </dd>
          </>
        )}
      </dl>
      <ol className="tx-list">
        {intent.txs.map((tx, i) => (
          <li key={i}>
            <div className="tx-title">
              {i + 1}. {txTitle(tx.label)} → {shortAddr(tx.to)}
            </div>
            <code className="calldata">{tx.data.slice(0, 18)}…</code>
          </li>
        ))}
      </ol>
      {simOk === true && <p className="hint">模拟通过</p>}
      {simOk === false && <p className="hint">模拟未通过</p>}
    </div>
  );
}

function RawToggle({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="advanced"
      open={open}
      onToggle={(e) => {
        setOpen((e.target as HTMLDetailsElement).open);
      }}
    >
      <summary>技术细节</summary>
      {children}
    </details>
  );
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
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const publicClient = usePublicClient({ chainId: 56 });

  useEffect(() => {
    getInjectedProvider();
  }, []);

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
        error: "签名页已过期。回聊天再说「确认」。",
      });
      return;
    }
    if (!publicClient) {
      setSim({ status: "warn", notes: [], error: "连不上 BSC，请核对钱包弹窗里的数量。" });
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

  async function connectWallet() {
    const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (!injected) {
      setError("没有可用的钱包连接器。");
      return;
    }
    try {
      setError("");
      await connectAsync({ connector: injected, chainId: bsc.id });
    } catch (e) {
      setError(connectErrorMessage(e));
    }
  }

  if (error && !intent) {
    return (
      <section className="call">
        <p className="kicker">打不开</p>
        <h1>链接无效或已失效</h1>
        <p className="banner danger">{error}</p>
      </section>
    );
  }
  if (!intent || !view || !ttl) {
    return (
      <section className="call">
        <p className="kicker">加载中</p>
        <h1>正在打开…</h1>
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
  const walletState = isConnected && address ? (boundOk ? "已连接" : "地址不对") : "未连接";
  const nft =
    view.nftId ??
    /#\d+/.exec(settledNote)?.[0] ??
    /NFT\s*#(\d+)/i.exec(settledNote)?.[0]?.replace(/^NFT\s*/i, "#");

  if (fullyBroadcast && !cancelled) {
    const legs = legsForView(view, "done");
    return (
      <section className="call call-done">
        <p className="kicker">
          已完成
          <span className="dot">·</span>
          {view.eyebrow}
        </p>
        <h1>{view.doneTitle}</h1>
        {view.doneBody && <p className="step">{view.doneBody}</p>}

        <AmountLegs left={legs.left} right={legs.right} />

        <div className="meta">
          {view.kind.startsWith("lp") && nft && (
            <MetaRow label="仓位">
              <span className="mono">{nft.startsWith("#") ? nft : `#${nft}`}</span>
            </MetaRow>
          )}
          {view.rangeLabel && <MetaRow label="区间">{view.rangeLabel}</MetaRow>}
          {view.feeLabel && <MetaRow label="费率">{view.feeLabel}</MetaRow>}
          {hashes.map((h, i) => (
            <MetaRow key={h} label={intent.txs[i] ? txTitle(intent.txs[i].label) : "交易"}>
              <a href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
                {shortAddr(h)}
              </a>
            </MetaRow>
          ))}
          <MetaRow label="钱包">
            <span className="wallet-addr">{shortAddr(intent.userAddress)}</span>
          </MetaRow>
        </div>

        {followUpError && twoStep && <p className="banner warn">{followUpError}</p>}
        {followUpUrl && (
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                window.location.href = followUpUrl;
              }}
            >
              继续组 LP
            </button>
          </div>
        )}

        <RawToggle>
          <ResultRaw intent={intent} />
        </RawToggle>
      </section>
    );
  }

  const legs = legsForView(view, "live");

  return (
    <section className={`call call-${statusKind}`}>
      <p className="kicker">
        {statusKind === "cancelled" ? "已取消" : statusKind === "expired" ? "已过期" : "待签名"}
        <span className="dot">·</span>
        {view.eyebrow}
        {statusKind === "live" && (
          <>
            <span className="dot">·</span>
            剩余 {ttl.text}
          </>
        )}
      </p>
      <h1>{cancelled ? "不会广播" : view.title}</h1>
      {view.stepLabel && !cancelled && <p className="step">{view.stepLabel}</p>}

      <AmountLegs left={legs.left} right={legs.right} />

      <div className="meta">
        {view.minGet && (
          <MetaRow label="最少到账">
            {view.minGet} {view.getSymbol}
          </MetaRow>
        )}
        {view.slippage && <MetaRow label="滑点">{view.slippage}</MetaRow>}
        {view.rangeLabel && <MetaRow label="区间">{view.rangeLabel}</MetaRow>}
        {view.feeLabel && <MetaRow label="费率">{view.feeLabel}</MetaRow>}
        {view.nftId && (
          <MetaRow label="仓位">
            <span className="mono">{view.nftId}</span>
          </MetaRow>
        )}
        {sim.status === "ok" && sim.gasBnb && (
          <MetaRow label="矿工费">{Number(sim.gasBnb).toPrecision(3)} BNB</MetaRow>
        )}
        {sim.status === "running" && <MetaRow label="矿工费">估算中</MetaRow>}
        <MetaRow label="钱包">
          <span className="meta-inline">
            <span className="wallet-addr">{shortAddr(intent.userAddress)}</span>
            <span className="hint">{walletState}</span>
            {isConnected ? (
              <button type="button" className="linkish" onClick={() => disconnect()}>
                断开
              </button>
            ) : (
              <button type="button" className="linkish" disabled={isPending} onClick={() => void connectWallet()}>
                {isPending ? "连接中" : "连接"}
              </button>
            )}
          </span>
        </MetaRow>
      </div>

      {sim.status === "warn" && <p className="banner warn">{sim.error ?? "模拟不完整，请看钱包弹窗。"}</p>}
      {sim.status === "fail" && <p className="banner danger">{sim.error ?? "模拟失败，不能签。"}</p>}
      {wrongWallet && <p className="banner warn">连上的不是绑定地址，请切换钱包。</p>}
      {wrongChain && (
        <p className="banner warn">
          当前不是 BNB Chain。
          <button type="button" className="linkish" onClick={() => switchChain({ chainId: 56 })}>
            切到 BSC
          </button>
        </p>
      )}
      {cancelled && <p className="banner warn">已取消。回聊天重新报价即可。</p>}
      {ttl.expired && !cancelled && <p className="banner warn">已过期。回聊天再说「确认」。</p>}
      {error && <p className="banner danger">{error}</p>}

      {hashes.length > 0 && (
        <div className="hashes">
          {hashes.map((h) => (
            <a key={h} href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
              {shortAddr(h)}
            </a>
          ))}
        </div>
      )}

      {!cancelled && (
        <div className="actions">
          {!isConnected ? (
            <button className="primary" disabled={isPending || ttl.expired} onClick={() => void connectWallet()}>
              {isPending ? "等待钱包" : "连接钱包"}
            </button>
          ) : (
            <button className="primary" disabled={!canSign} onClick={() => void onSign()}>
              {sending ? "等待确认" : sim.status === "running" ? "模拟中" : view.cta}
            </button>
          )}
          <button className="ghost" disabled={!canCancel || cancelling} onClick={() => void onCancel()}>
            {cancelling ? "取消中" : "取消"}
          </button>
        </div>
      )}
      {!isConnected && !cancelled && (
        <p className="hint">点连接后应弹出 OKX / MetaMask。若没弹窗，用钱包内置浏览器打开此链接。</p>
      )}

      <RawToggle>
        <ResultRaw intent={intent} simOk={sim.status === "ok" ? true : sim.status === "fail" ? false : undefined} />
        {intent.risks.length > 0 && (
          <ul className="risks">
            {intent.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </RawToggle>
    </section>
  );
}
