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
import { buildIntentView, remainingLabel, shortAddr, txTitle } from "../../../lib/intentView";
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

  useEffect(() => {
    if (!intent || intent.cancelledAt) return;
    if (!publicClient) {
      setSim({ status: "warn", notes: [], error: "BSC RPC is not connected, so simulation is skipped. Check the wallet popup yourself." });
      return;
    }
    const from = address && boundOk ? address : intent.userAddress;
    let cancelled = false;
    setSim({ status: "running", notes: [] });
    simulateIntentTxs(publicClient, from, intent.txs)
      .then((next) => {
        if (!cancelled) setSim(next);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setSim({
            status: "warn",
            notes: [],
            error: `Could not simulate: ${e.message}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [intent, publicClient, address, boundOk]);

  async function onSign() {
    if (!intent || !address) return;
    if (!boundOk) {
      setError("Switch to the bound wallet before signing.");
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
    return <div className="card muted">Loading this intent…</div>;
  }

  const cancelled = Boolean(intent.cancelledAt);
  const fullyBroadcast = intent.txs.length > 0 && hashesReady(intent, log);
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

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h1>{cancelled ? "Cancelled" : view.title}</h1>
          <p className="muted tight">{cancelled ? "Will not broadcast" : ttl.text}</p>
        </div>
        <span className="chip">BNB Chain</span>
      </div>

      <div className="exchange" aria-label="You pay and you receive">
        <div className="leg">
          <div className="leg-kicker">You pay</div>
          <div className="amt">{view.payAmount}</div>
          <div className="sym">{view.paySymbol}</div>
          {view.payName && view.payName !== view.paySymbol && <div className="hint">{view.payName}</div>}
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="leg">
          <div className="leg-kicker">You receive</div>
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
              Min out <strong>{view.minGet} {view.getSymbol}</strong>
            </>
          )}
          {view.minGet && view.slippage && " · "}
          {view.slippage && <>Slippage {view.slippage}</>}
        </p>
      )}

      <p className="footnote">{view.footnote} Not investment advice.</p>

      {sim.status === "running" && <p className="guard">Simulating and estimating gas…</p>}
      {sim.status === "ok" && sim.gasBnb && (
        <p className="guard">
          Simulation passed · estimated miner fee ~ <strong>{Number(sim.gasBnb).toPrecision(4)} BNB</strong>
        </p>
      )}
      {sim.status === "warn" && (
        <p className="banner warn">{sim.error ?? "Simulation is incomplete. Check the wallet popup yourself."}</p>
      )}
      {sim.status === "fail" && <p className="banner danger">{sim.error ?? "Simulation failed. Confirm is blocked."}</p>}

      <div className="wallet-row">
        <div>
          <div className="leg-kicker">Wallet</div>
          <div className="wallet-addr">
            {isConnected && address ? shortAddr(address) : "Not connected"}
          </div>
          <div className="hint">Must be {shortAddr(intent.userAddress)}</div>
        </div>
        {isConnected ? (
          <button type="button" className="ghost" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" className="ghost" disabled={isPending} onClick={connectWallet}>
            {isPending ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>

      {wrongWallet && <p className="banner warn">Connected wallet is not the bound address. Cannot sign.</p>}
      {wrongChain && (
        <p className="banner warn">
          This is not BNB Chain.
          <button type="button" className="linkish" onClick={() => switchChain({ chainId: 56 })}>
            Switch network
          </button>
        </p>
      )}
      {cancelled && <p className="banner warn">Cancelled. Tokens stay in your wallet. Go back to chat for a new quote.</p>}
      {ttl.expired && !cancelled && <p className="banner warn">Intent expired. Ask the agent for a new quote.</p>}
      {error && <p className="banner danger">{error}</p>}

      {!cancelled && !fullyBroadcast && (
        <>
          {!isConnected ? (
            <button className="primary" disabled={isPending || ttl.expired} onClick={connectWallet}>
              {isPending ? "Waiting for wallet…" : "Connect wallet to confirm"}
            </button>
          ) : (
            <button className="primary" disabled={!canSign} onClick={() => void onSign()}>
              {sending ? "Waiting for wallet…" : sim.status === "running" ? "Simulating…" : view.cta}
            </button>
          )}
          <button className="ghost cancel" disabled={!canCancel || cancelling} onClick={() => void onCancel()}>
            {cancelling ? "Cancelling…" : "Cancel this"}
          </button>
        </>
      )}

      {hashes.length > 0 && (
        <div className="success">
          <div className="leg-kicker">Broadcast</div>
          {hashes.map((h) => (
            <a key={h} href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
              {shortAddr(h)}
            </a>
          ))}
        </div>
      )}

      <details className="advanced">
        <summary>Raw amounts</summary>
        <dl className="kv">
          {typeof intent.summary.amountInRaw === "string" && (
            <>
              <dt>Pay raw</dt>
              <dd>
                <code>{intent.summary.amountInRaw}</code>
              </dd>
            </>
          )}
          {typeof intent.summary.amountOutRaw === "string" && (
            <>
              <dt>Receive raw</dt>
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
        <p className="hint">The chain only uses raw. The share amounts above are for reading.</p>
      </details>

      <details className="advanced">
        <summary>Transactions to broadcast ({intent.txs.length})</summary>
        <ol className="tx-list">
          {intent.txs.map((tx, i) => (
            <li key={i}>
              <div className="tx-title">
                {i + 1}. {txTitle(tx.label)}
              </div>
              <div className="hint">
                to <code>{shortAddr(tx.to)}</code>
              </div>
              <code className="calldata">{tx.data.slice(0, 22)}…</code>
            </li>
          ))}
        </ol>
        <p className="hint">
          {sim.status === "ok"
            ? "On-chain simulation passed."
            : sim.status === "fail"
              ? "On-chain simulation failed."
              : intent.simulation.ok
                ? "Runtime encoded the calls; this page simulates again."
                : "Encoding check failed."}
        </p>
        {sim.notes.length > 0 && (
          <ul className="risks">
            {sim.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </details>

      {intent.risks.length > 0 && (
        <details className="advanced">
          <summary>Risk notes</summary>
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
