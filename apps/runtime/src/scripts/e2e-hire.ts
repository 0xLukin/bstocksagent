/**
 * End-to-end Termix hire: buyer wallet + agent wallet.
 *
 * Default is dry-run (off-chain API + printed intents). Pass --broadcast to send txs.
 *
 *   pnpm termix:e2e-hire
 *   pnpm termix:e2e-hire -- --broadcast
 *   pnpm termix:e2e-hire -- --via-agent --broadcast --reset
 *   pnpm termix:e2e-hire -- --from checkout --broadcast
 *
 * Fill BUYER_WALLET_KEY in .env first. Never reuse WALLET_KEY as the buyer.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, fallback, formatEther, formatUnits, http, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { buildDeliveryReport, renderMarkdown } from "@bstocks/report";
import { findRepoRoot, loadRepoEnv } from "@bstocks/chain";
import {
  acceptOffer,
  agentByTx,
  broadcastIntent,
  buyerWalletKeyOrNull,
  checkoutTxIntent,
  confirmCheckout,
  createCheckoutSession,
  createConversation,
  currencyContracts,
  fetchContracts,
  getCheckout,
  getConversation,
  getListing,
  getOffer,
  getOnchainTx,
  getMe,
  getOrder,
  listingDraft,
  listAccountAgents,
  listConversationMessages,
  listConversations,
  listOwnedAgents,
  nameAvailability,
  prepareBuyerAcceptDelivery,
  prepareMint,
  prepareProviderAccept,
  recoverCheckout,
  registerArtifact,
  requestDeliveryUploadUrl,
  requireWalletKey,
  sendConversationMessage,
  sendConversationOffer,
  sha256Hex,
  submitDelivery,
  TermixClient,
  TermixHttpError,
  unwrapOwnedAgents,
  walletLogin,
  type OwnedAgent,
  type TxIntent,
} from "@bstocks/termix";
import { findLiveOffer, phaseFromOrderStatus } from "../hire.js";

loadRepoEnv();

const DEFAULT_LISTING_ID = "cmtdjaletb3yftg012bh5xma2";
const MIN_BNB = 0.002;
const BUY_TEXT = "用 0.01 USDC 买英伟达";
const EARLY_BUY_TEXT = "用 10 USDT 买英伟达";
const SIGNER_RE = /https?:\/\/[^\s)`'"<>]+\/t\/[A-Za-z0-9_-]+/;
const PREVIOUS_OFFER_ID = process.env.E2E_PREVIOUS_OFFER_ID ?? "cmtdmoldzcfrptg01lmyl8ts6";
const PREVIOUS_ORDER_ID = process.env.E2E_PREVIOUS_ORDER_ID ?? "cmtdn1zx6cl3ktg018i0507hg";
const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

type HireState = {
  sellerAddress?: string;
  buyerAddress?: string;
  buyerAccountId?: string;
  buyerAgentId?: string;
  buyerAgentHandle?: string;
  conversationId?: string;
  offerId?: string;
  revisionId?: string;
  revisionVersion?: number;
  checkoutId?: string;
  orderId?: string;
  reportPath?: string;
  knownOfferIds?: string[];
  txs: Array<{ step: string; hash: string }>;
};

const STEPS = [
  "preflight",
  "buyer-agent",
  "conversation",
  "offer",
  "accept-offer",
  "checkout",
  "provider-accept",
  "deliver",
  "settle",
] as const;
type Step = (typeof STEPS)[number];

function argFlag(name: string) {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("-") ? v : undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function messageText(row: Record<string, unknown>): string {
  return typeof row.text === "string" ? row.text : "";
}

function pickSigner(text: string): string | undefined {
  return text.match(SIGNER_RE)?.[0];
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, tries = 36, delayMs = 5000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const hit = await fn();
      if (hit !== undefined) return hit;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`waiting ${label}`, i + 1, "/", tries, "err", msg.slice(0, 160));
      await sleep(delayMs);
      continue;
    }
    console.log(`waiting ${label}`, i + 1, "/", tries);
    await sleep(delayMs);
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error(`Timed out waiting for ${label}`);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickStr(v: unknown, ...keys: string[]): string | undefined {
  const obj = asRecord(v);
  for (const k of keys) {
    const x = obj[k];
    if (typeof x === "string" && x) return x;
    if (typeof x === "number") return String(x);
  }
  for (const nested of ["offer", "current", "revision", "order", "agent", "data"]) {
    if (obj[nested]) {
      const inner = pickStr(obj[nested], ...keys);
      if (inner) return inner;
    }
  }
  return undefined;
}

function pickNum(v: unknown, ...keys: string[]): number | undefined {
  const obj = asRecord(v);
  for (const k of keys) {
    const x = obj[k];
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string" && x && Number.isFinite(Number(x))) return Number(x);
  }
  return undefined;
}

function dataDir() {
  const root = findRepoRoot();
  return process.env.DATA_DIR?.startsWith("/")
    ? process.env.DATA_DIR
    : join(root, process.env.DATA_DIR ?? ".data");
}

function statePath() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, "e2e-hire.json");
}

function loadState(): HireState {
  const p = statePath();
  if (!existsSync(p)) return { txs: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as HireState;
    return { ...raw, txs: raw.txs ?? [] };
  } catch {
    return { txs: [] };
  }
}

function saveState(state: HireState) {
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

function rpcUrl() {
  return process.env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com";
}

function publicClient() {
  const fallbackUrl = process.env.BSC_RPC_FALLBACK_URL ?? "https://bsc-dataseed.binance.org";
  return createPublicClient({
    chain: bsc,
    transport: fallback([http(rpcUrl()), http(fallbackUrl)]),
  });
}

async function waitTx(client: TermixClient, hash: Hex, label: string) {
  console.log(`${label} ${hash}`);
  try {
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error(`${label} reverted: ${hash}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverted")) throw e;
    console.log("  receipt wait failed, polling Termix indexer", msg.split("\n")[0]);
  }
  for (let i = 0; i < 16; i++) {
    const st = await getOnchainTx(client, hash);
    console.log("  indexer", st.status ?? "(pending)");
    if (String(st.status ?? "").toUpperCase() === "CONFIRMED") return;
    await sleep(2500);
  }
}

async function resolveMintedAgent(client: TermixClient, hash: string, handle?: string, accountId?: string) {
  for (let i = 0; i < 20; i++) {
    const st = await agentByTx(client, hash);
    let id = st.agent?.id;
    if ((st.status === "CONFIRMED" || String(st.status ?? "").toUpperCase() === "CONFIRMED") && !id) {
      const again = await ownedAgentsFor(client, accountId);
      id = pickBuyerAgent(again, handle)?.id;
    }
    console.log("  mint indexer", st.status, id ?? st.agent?.agentTokenId);
    if (id) {
      return { id, handle: st.agent?.name ?? handle };
    }
    await sleep(3000);
  }
  return undefined;
}

function intentDone(checkout: Record<string, unknown>, action: string) {
  const intents = Array.isArray(checkout.txIntents) ? checkout.txIntents : [];
  return intents.some((row) => {
    const r = asRecord(row);
    return (
      r.action === action &&
      (typeof r.txHash === "string" || r.status === "SUBMITTED" || r.status === "CONFIRMED")
    );
  });
}

async function ownedAgentsFor(client: TermixClient, accountId?: string): Promise<OwnedAgent[]> {
  if (accountId) {
    const fromAccount = unwrapOwnedAgents(await listAccountAgents(client, accountId));
    if (fromAccount.length) return fromAccount;
  }
  return unwrapOwnedAgents(await listOwnedAgents(client));
}

function pickBuyerAgent(owned: OwnedAgent[], preferred?: string): OwnedAgent | undefined {
  if (preferred) {
    const hit = owned.find((a) => a.id === preferred || a.agentTokenId === preferred || a.name === preferred);
    if (hit?.id) return hit;
  }
  return owned.find((a) => a.id && (a.name?.startsWith("btest") || a.name?.startsWith("bt"))) ?? owned.find((a) => a.id);
}

function parseOffer(raw: unknown) {
  const root = asRecord(raw);
  const offer = asRecord(root.offer).id ? asRecord(root.offer) : root;
  const current = asRecord(offer.current).id ? asRecord(offer.current) : asRecord(offer.revision);
  return {
    id: pickStr(offer, "id", "offerId"),
    revisionId: pickStr(current, "id") ?? pickStr(offer, "revisionId", "acceptedRevisionId"),
    version: pickNum(current, "version") ?? pickNum(offer, "expectedVersion", "version") ?? 1,
    status: pickStr(offer, "status"),
    price: pickStr(current, "price") ?? pickStr(offer, "price"),
  };
}

function walkOffers(raw: unknown): unknown[] {
  const obj = asRecord(raw);
  const bags = [obj.offers, obj.items, asRecord(obj.offer).id ? [obj.offer] : null];
  const out: unknown[] = [];
  for (const bag of bags) {
    if (Array.isArray(bag)) out.push(...bag);
  }
  return out;
}

function checkoutIdOf(raw: unknown) {
  return pickStr(raw, "id", "checkoutId");
}

function orderIdOf(raw: unknown) {
  return pickStr(raw, "orderId") ?? pickStr(asRecord(raw).order, "id", "orderId");
}

async function pollCheckoutOrder(buyer: TermixClient, checkoutId: string) {
  for (let i = 0; i < 30; i++) {
    const row = await getCheckout(buyer, checkoutId);
    const orderId = orderIdOf(row);
    if (orderId) return { row, orderId };
    await sleep(4000);
  }
  try {
    const recovered = await recoverCheckout(buyer, checkoutId);
    const orderId = orderIdOf(recovered);
    if (orderId) return { row: recovered, orderId };
  } catch {
    /* continue */
  }
  throw new Error(`Checkout ${checkoutId} did not produce an orderId`);
}

async function maybeBroadcast(intent: TxIntent, walletKey: `0x${string}`, broadcast: boolean, label: string) {
  console.log(`${label} intent`, { action: intent.action, to: intent.to ?? intent.contract, chainId: intent.chainId });
  if (!broadcast) {
    console.log(`Dry run. Re-run with --broadcast to send ${label}.`);
    return undefined;
  }
  return broadcastIntent(intent, walletKey);
}

async function main() {
  const broadcast = argFlag("--broadcast");
  const reset = argFlag("--reset");
  const skipDeliver = argFlag("--skip-deliver");
  const skipSettle = argFlag("--skip-settle");
  const viaAgent = argFlag("--via-agent");
  const skipDefi = argFlag("--skip-defi");
  const from = (argValue("--from") as Step | undefined) ?? "preflight";
  if (from && !STEPS.includes(from)) {
    throw new Error(`Unknown --from ${from}. Use: ${STEPS.join(", ")}`);
  }
  if (reset && existsSync(statePath())) unlinkSync(statePath());

  const state = loadState();
  const startAt = STEPS.indexOf(from);
  const should = (step: Step) => STEPS.indexOf(step) >= startAt;

  const listingId = process.env.TERMIX_LISTING_ID ?? DEFAULT_LISTING_ID;
  const providerAgentId = process.env.TERMIX_AGENT_ID;
  const draft = listingDraft();
  const price = process.env.LISTING_BASE_PRICE ?? draft.basePrice;
  const currency = (process.env.LISTING_CURRENCY ?? draft.currency) as "USDC" | "USDT";
  const sellerKey = process.env.WALLET_KEY ? requireWalletKey() : null;
  const buyerKey = buyerWalletKeyOrNull();

  console.log("bStocks e2e hire");
  console.log("mode", broadcast ? "broadcast" : "dry-run", viaAgent ? "via-agent" : "script-seller");
  console.log("listing", listingId);
  console.log("price", price, currency);
  console.log("state", statePath());

  if (!should("preflight")) {
    /* still need wallets below */
  }

  if (!sellerKey) {
    console.log("WALLET_KEY is empty. This is the existing agent / escrow wallet. Fill it in .env.");
  }
  if (!buyerKey) {
    console.log(
      [
        "BUYER_WALLET_KEY is empty. Add a second BSC wallet to .env (not WALLET_KEY):",
        "",
        "  BUYER_WALLET_KEY=0x...",
        "  TERMIX_BUYER_AGENT_ID=          # optional, filled after first mint",
        `  TERMIX_LISTING_ID=${listingId}`,
        "",
        "Buyer needs BNB for gas and at least",
        `  ${price} ${currency} on BSC for escrow.`,
        "Then: pnpm termix:e2e-hire",
        "On-chain: pnpm termix:e2e-hire -- --broadcast",
      ].join("\n"),
    );
    if (broadcast) process.exit(1);
    if (!sellerKey) return;
  }

  if (!providerAgentId) {
    throw new Error("TERMIX_AGENT_ID is not set. This is the seller / bStocks agent cuid.");
  }

  const seller = new TermixClient();
  const buyer = new TermixClient();
  const anon = new TermixClient();
  const contracts = await fetchContracts(anon);
  const pay = currencyContracts(contracts, currency);
  console.log("Termix", { chainId: contracts.chainId, escrow: pay.contracts.escrow, token: pay.address, decimals: pay.decimals });

  try {
    const listing = await getListing(anon, listingId);
    console.log("listing", {
      id: pickStr(listing, "id") ?? listingId,
      status: pickStr(listing, "status"),
      title: pickStr(listing, "title"),
      price: pickStr(listing, "basePrice", "price") ?? price,
    });
  } catch (e) {
    console.log("listing lookup failed (continuing with custom offer)", e instanceof Error ? e.message : e);
  }

  const read = publicClient();
  if (sellerKey) {
    const sellerAccount = privateKeyToAccount(sellerKey);
    state.sellerAddress = sellerAccount.address;
    const bnb = formatEther(await read.getBalance({ address: sellerAccount.address }));
    console.log("seller", sellerAccount.address, "BNB", bnb);
    if (Number(bnb) < MIN_BNB) console.log("seller BNB is low; accept/deliver will need gas");
  }
  if (buyerKey) {
    const buyerAccount = privateKeyToAccount(buyerKey);
    state.buyerAddress = buyerAccount.address;
    if (state.sellerAddress && state.sellerAddress.toLowerCase() === buyerAccount.address.toLowerCase()) {
      throw new Error("BUYER_WALLET_KEY is the same wallet as WALLET_KEY. Use a different buyer.");
    }
    const [bnbRaw, usdcRaw] = await Promise.all([
      read.getBalance({ address: buyerAccount.address }),
      read.readContract({
        address: pay.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [buyerAccount.address],
      }),
    ]);
    const bnb = formatEther(bnbRaw);
    const usdc = formatUnits(usdcRaw, pay.decimals);
    console.log("buyer", buyerAccount.address, "BNB", bnb, currency, usdc);
    if (Number(bnb) < MIN_BNB) console.log(`buyer BNB < ${MIN_BNB}; mint/checkout/settle need gas`);
    if (Number(usdc) < Number(price)) {
      console.log(`buyer ${currency} ${usdc} < ${price}. Fund the buyer on BSC before --broadcast checkout.`);
      if (broadcast && should("checkout")) {
        throw new Error(`Buyer needs at least ${price} ${currency} on BSC`);
      }
    }
  }
  saveState(state);
  if (!buyerKey || !sellerKey) return;

  console.log("login seller + buyer…");
  await walletLogin(seller, sellerKey);
  const buyerSession = await walletLogin(buyer, buyerKey);
  const buyerMe = await getMe(buyer);
  state.buyerAccountId =
    pickStr(buyerMe, "id", "accountId") ??
    pickStr(asRecord(buyerMe.account), "id") ??
    buyerSession.account?.id;
  saveState(state);

  if (should("buyer-agent")) {
    const owned = await ownedAgentsFor(buyer, state.buyerAccountId);
    console.log(
      "buyer agents",
      owned.map((a) => ({ id: a.id, name: a.name, token: a.agentTokenId })),
    );
    let agent = pickBuyerAgent(owned, process.env.TERMIX_BUYER_AGENT_ID ?? state.buyerAgentId);
    const existingMint = state.txs.find((t) => t.step === "buyer-mint")?.hash;
    if (!agent?.id && existingMint) {
      console.log("recovering buyer agent from mint", existingMint);
      const recovered = await resolveMintedAgent(buyer, existingMint, state.buyerAgentHandle, state.buyerAccountId);
      if (recovered?.id) {
        agent = { id: recovered.id, name: recovered.handle };
      }
    }
    if (!agent?.id) {
      const suffix = buyerAccountSuffix(state.buyerAddress!);
      let handle = `btest${suffix}`;
      for (let i = 0; i < 6; i++) {
        const avail = await nameAvailability(buyer, handle);
        if (avail.available) break;
        handle = `btest${suffix}${i + 1}`;
      }
      state.buyerAgentHandle = handle;
      console.log("buyer has no agent; will mint", handle);
      const prepared = await prepareMint(buyer, {
        name: handle,
        displayName: "bStocks E2E Buyer",
        category: "Automation & Ops",
        description: "Test buyer identity for the bStocks hire e2e script. Not a public service.",
        tags: ["bstocks", "e2e"],
      });
      const hash = await maybeBroadcast(
        { chainId: 56, contract: prepared.contract, callData: prepared.callData, value: "0" },
        buyerKey,
        broadcast,
        "buyer-mint",
      );
      if (!hash) {
        console.log("Mint not sent. Fill BUYER_WALLET_KEY, fund BNB, then --broadcast to continue.");
        saveState(state);
        return;
      }
      state.txs.push({ step: "buyer-mint", hash });
      saveState(state);
      await waitTx(buyer, hash, "buyer-mint");
      const minted = await resolveMintedAgent(buyer, hash, handle, state.buyerAccountId);
      if (minted?.id) {
        state.buyerAgentId = minted.id;
        state.buyerAgentHandle = minted.handle;
      }
      if (!state.buyerAgentId) throw new Error("Buyer mint confirmed but platform id not found. Re-run the script.");
      console.log(`Set TERMIX_BUYER_AGENT_ID=${state.buyerAgentId} in .env to reuse this agent.`);
    } else {
      state.buyerAgentId = agent.id;
      state.buyerAgentHandle = agent.name;
      console.log("using buyer agent", agent.id, agent.name);
    }
    saveState(state);
  }
  if (!state.buyerAgentId) throw new Error("buyerAgentId missing. Re-run from --from buyer-agent");

  if (should("conversation")) {
    let justOpened = false;
    if (!state.conversationId) {
      const listed = await listConversations(buyer);
      const existing = (listed.items ?? []).find((row) => {
        const blob = JSON.stringify(row);
        return blob.includes(providerAgentId) && blob.includes(state.buyerAgentId!);
      });
      if (existing && typeof existing.id === "string") {
        state.conversationId = existing.id;
        console.log("reuse conversation", state.conversationId);
      } else {
        try {
          const created = await createConversation(buyer, {
            kind: "DIRECT_MESSAGE",
            targetAgentId: providerAgentId,
            initiatorAgentId: state.buyerAgentId,
          });
          state.conversationId = created.id;
          justOpened = true;
          console.log("opened conversation", state.conversationId);
        } catch (e) {
          if (e instanceof TermixHttpError) {
            const id = pickStr(safeJson(e.body), "id", "conversationId");
            if (id) {
              state.conversationId = id;
              console.log("reuse conversation from error", id);
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
      }
    } else {
      console.log("conversation", state.conversationId);
    }
    const knownOfferIds = new Set(
      walkOffers(await getConversation(buyer, state.conversationId!))
        .map(parseOffer)
        .map((o) => o.id)
        .filter((id): id is string => Boolean(id)),
    );
    if (justOpened || viaAgent) {
      const geo =
        "I confirm I am not in the United States or a restricted region. This is an e2e hire test.";
      const ask = viaAgent
        ? justOpened
          ? "请发标准报价"
          : "再来一单"
        : `Please send a ${price} ${currency} Standard offer for listing ${listingId}. Scope: whitelist bStocks / PancakeSwap V3 execution report.`;
      await sendConversationMessage(buyer, state.conversationId!, geo, state.buyerAgentId);
      await sendConversationMessage(buyer, state.conversationId!, ask, state.buyerAgentId);
      console.log("buyer messages sent", viaAgent ? `(via-agent: ${ask})` : "");
    }
    state.knownOfferIds = [...knownOfferIds];
    saveState(state);
  }
  if (!state.conversationId) throw new Error("conversationId missing");

  if (should("offer")) {
    if (state.offerId) {
      const live = parseOffer(await getOffer(seller, state.offerId));
      if (live.status === "WITHDRAWN" || live.status === "EXPIRED" || live.status === "DECLINED") {
        console.log("stored offer is", live.status, "— sending a new one");
        state.offerId = undefined;
        state.revisionId = undefined;
      }
    }
    if (!state.offerId) {
      const convo = await getConversation(viaAgent ? buyer : seller, state.conversationId);
      const prior = walkOffers(convo)
        .map(parseOffer)
        .find((o) => o.id && o.status === "ACTIVE");
      if (prior?.id && prior.revisionId && !viaAgent) {
        state.offerId = prior.id;
        state.revisionId = prior.revisionId;
        state.revisionVersion = prior.version;
        console.log("reuse ACTIVE offer", state.offerId);
      } else if (viaAgent) {
        console.log("via-agent: waiting for runtime to send_termix_offer…");
        const parsed = await waitFor("agent offer", async () => {
          const live = await findLiveOffer(buyer, state.conversationId!);
          if (!live?.id) return undefined;
          if (live.id === PREVIOUS_OFFER_ID) return undefined;
          const full = parseOffer(await getOffer(buyer, live.id));
          if (full.status && full.status !== "ACTIVE") return undefined;
          if (Number(full.price) !== Number(price)) return undefined;
          if (!full.revisionId) return undefined;
          return full;
        });
        if (parsed.id === PREVIOUS_OFFER_ID) {
          throw new Error(`Reused settled offer ${PREVIOUS_OFFER_ID}`);
        }
        if (Number(parsed.price) !== Number(price)) {
          throw new Error(`Offer ${parsed.id} price ${parsed.price} != listing ${price}`);
        }
        state.offerId = parsed.id;
        state.revisionId = parsed.revisionId;
        state.revisionVersion = parsed.version;
        console.log("agent offer", { id: state.offerId, revision: state.revisionId, version: state.revisionVersion, price: parsed.price });
      } else {
        const sent = await sendConversationOffer(seller, state.conversationId, {
          providerAgentId,
          price,
          currency,
          deliveryDays: Number(process.env.LISTING_DELIVERY_DAYS ?? draft.deliveryDays),
          scope: draft.packages[0]?.scope ?? "Whitelist bStocks / PancakeSwap V3 e2e hire test.",
          message: `E2e offer for listing ${listingId}`,
          proofMethod: "manual",
          settlementType: "escrow",
        });
        let parsed = parseOffer(sent);
        if (!parsed.id || !parsed.revisionId) {
          const convoAfter = await getConversation(seller, state.conversationId);
          parsed =
            walkOffers(convoAfter)
              .map(parseOffer)
              .find((o) => o.id) ?? parsed;
        }
        if (parsed.id && !parsed.revisionId) {
          parsed = parseOffer(await getOffer(seller, parsed.id));
        }
        if (!parsed.id || !parsed.revisionId) {
          throw new Error(`Offer response missing ids: ${JSON.stringify(sent).slice(0, 500)}`);
        }
        state.offerId = parsed.id;
        state.revisionId = parsed.revisionId;
        state.revisionVersion = parsed.version;
        console.log("offer", { id: state.offerId, revision: state.revisionId, version: state.revisionVersion, price: parsed.price });
      }
    }
    saveState(state);
  }
  if (!state.offerId || !state.revisionId) throw new Error("offerId/revisionId missing");

  if (viaAgent && should("offer") && broadcast) {
    const beforeEarly = await listConversationMessages(buyer, state.conversationId!);
    const beforeEarlyCount = beforeEarly.items?.length ?? 0;
    await sendConversationMessage(buyer, state.conversationId!, EARLY_BUY_TEXT, state.buyerAgentId);
    console.log("via-agent: offered-phase probe", EARLY_BUY_TEXT);
    const earlyReply = await waitFor("hire_not_ready before checkout", async () => {
      const msgs = await listConversationMessages(buyer, state.conversationId!);
      const fresh = (msgs.items ?? []).slice(beforeEarlyCount);
      const blob = fresh.map(messageText).join("\n");
      if (pickSigner(blob)) {
        throw new Error(`Signer page leaked before checkout: ${blob.slice(0, 240)}`);
      }
      const hit = fresh.find((m) => {
        const text = messageText(m);
        return Boolean(text) && text.trim() !== EARLY_BUY_TEXT;
      });
      return hit ? messageText(hit) : undefined;
    });
    if (!/hire_not_ready|accept the .* offer|finish (?:the )?Termix checkout|先.*(?:报价|托管|checkout)|Accept that card/i.test(earlyReply)) {
      console.log("offered-phase reply did not name checkout (still no signer):\n", earlyReply.slice(0, 600));
    } else {
      console.log("offered-phase blocked DeFi\n", earlyReply.slice(0, 600));
    }
  }

  if (should("accept-offer")) {
    const live = parseOffer(await getOffer(buyer, state.offerId));
    state.revisionId = live.revisionId ?? state.revisionId;
    state.revisionVersion = live.version;
    if (live.status === "ACTIVE") {
      const accepted = await acceptOffer(buyer, state.offerId, {
        revisionId: state.revisionId,
        expectedVersion: state.revisionVersion ?? 1,
        clientAgentId: state.buyerAgentId,
      });
      console.log("offer accepted", pickStr(accepted, "status") ?? live.status);
    } else {
      console.log("offer already", live.status);
    }
    saveState(state);
  }

  if (should("checkout")) {
    if (!state.checkoutId) {
      try {
        const session = await createCheckoutSession(buyer, {
          offerId: state.offerId,
          revisionId: state.revisionId,
          idempotencyKey: `checkout-${state.offerId}`,
          clientAgentId: state.buyerAgentId,
        });
        state.checkoutId = checkoutIdOf(session);
        state.orderId = orderIdOf(session) ?? state.orderId;
      } catch (e) {
        if (!(e instanceof TermixHttpError)) throw e;
        const id = pickStr(safeJson(e.body), "id", "checkoutId");
        if (!id) throw e;
        state.checkoutId = id;
      }
      console.log("checkout session", state.checkoutId);
    }
    if (!state.checkoutId) throw new Error("checkout session missing id");
    let checkout = await getCheckout(buyer, state.checkoutId);
    state.orderId = orderIdOf(checkout) ?? state.orderId;

    if (!state.orderId && !intentDone(checkout, "approveEscrow")) {
      const allowance = await read.readContract({
        address: pay.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [state.buyerAddress as `0x${string}`, pay.contracts.escrow],
      });
      const need = parseUnits(price, pay.decimals);
      if (allowance >= need) {
        console.log("existing", currency, "allowance covers escrow — skipping approve");
      } else {
        const approve = await checkoutTxIntent(buyer, state.checkoutId, "approveEscrow");
        const hash = await maybeBroadcast(approve, buyerKey, broadcast, "approveEscrow");
        if (!hash) {
          saveState(state);
          return;
        }
        state.txs.push({ step: "approveEscrow", hash });
        await waitTx(buyer, hash, "approveEscrow");
      }
    }

    checkout = await getCheckout(buyer, state.checkoutId);
    state.orderId = orderIdOf(checkout) ?? state.orderId;
    if (!state.orderId) {
      const create = await checkoutTxIntent(buyer, state.checkoutId, "createOrder");
      const hash = await maybeBroadcast(create, buyerKey, broadcast, "createOrder");
      if (!hash) {
        saveState(state);
        return;
      }
      state.txs.push({ step: "createOrder", hash });
      await confirmCheckout(buyer, state.checkoutId, hash);
      await waitTx(buyer, hash, "createOrder");
      const funded = await pollCheckoutOrder(buyer, state.checkoutId);
      state.orderId = funded.orderId;
    }
    console.log("order", state.orderId);
    if (state.orderId === PREVIOUS_ORDER_ID) {
      throw new Error(`Reused settled order ${PREVIOUS_ORDER_ID}`);
    }
    saveState(state);
  }
  if (should("checkout") && broadcast && !state.orderId) throw new Error("orderId missing after checkout");

  if (should("provider-accept")) {
    if (!state.orderId) {
      console.log("No order yet. Re-run with --broadcast to fund escrow.");
      saveState(state);
      return;
    }
    if (viaAgent) {
      console.log("via-agent: waiting for runtime provider_accept_order…");
      const accepted = await waitFor("agent accept", async () => {
        const order = await getOrder(buyer, state.orderId!);
        const phase = phaseFromOrderStatus(order.status);
        console.log("  order", order.status, (order as { latestEventName?: string }).latestEventName ?? "");
        if (phase === "working" || phase === "delivered" || phase === "settled") return order;
        if (phase === "funded") {
          try {
            await prepareProviderAccept(seller, state.orderId!);
          } catch (e) {
            const msg = e instanceof Error ? e.message : "";
            if (/not awaiting provider acceptance/i.test(msg)) return order;
          }
        }
        return undefined;
      });
      console.log("agent accepted", accepted.status);
    } else {
      const order = await getOrder(seller, state.orderId);
      console.log("order status", order.status, "actions", order.availableActions);
      try {
        const intent = await prepareProviderAccept(seller, state.orderId);
        const hash = await maybeBroadcast(intent, sellerKey, broadcast, "provider-accept");
        if (!hash) {
          saveState(state);
          return;
        }
        state.txs.push({ step: "provider-accept", hash });
        await waitTx(seller, hash, "provider-accept");
      } catch (e) {
        console.log("provider-accept skipped", e instanceof Error ? e.message : e);
      }
    }
    saveState(state);
  }

  if (viaAgent && !skipDefi && state.orderId && broadcast) {
    const before = await listConversationMessages(buyer, state.conversationId!);
    const beforeCount = before.items?.length ?? 0;
    await sendConversationMessage(buyer, state.conversationId!, BUY_TEXT, state.buyerAgentId);
    console.log("via-agent: sent", BUY_TEXT);
    await waitFor("agent quote", async () => {
      const msgs = await listConversationMessages(buyer, state.conversationId!);
      const fresh = (msgs.items ?? []).slice(beforeCount);
      const hit = fresh.find((m) => {
        const text = messageText(m);
        if (!text || text.trim() === BUY_TEXT) return false;
        return /NVDAB|~0\.|报价|confirm|确认执行|Signer|raw/i.test(text);
      });
      if (!hit) return undefined;
      const text = messageText(hit);
      if (/hire_not_ready|accept the 0\.01 USDC offer|Finish the Termix hire/i.test(text)) {
        throw new Error(`Agent blocked DeFi after accept: ${text.slice(0, 240)}`);
      }
      console.log("agent quote\n", text.slice(0, 800));
      return text;
    });
    const afterQuote = (await listConversationMessages(buyer, state.conversationId!)).items?.length ?? 0;
    await sendConversationMessage(buyer, state.conversationId!, "确认执行", state.buyerAgentId);
    const signerUrl = await waitFor("signer url", async () => {
      const msgs = await listConversationMessages(buyer, state.conversationId!);
      const fresh = (msgs.items ?? []).slice(afterQuote);
      const blob = fresh.map(messageText).join("\n");
      const url = pickSigner(blob);
      if (url) return url;
      if (/hire_not_ready|Finish the Termix hire/i.test(blob)) {
        throw new Error(`Agent refused signer page: ${blob.slice(0, 240)}`);
      }
      return undefined;
    });
    console.log("SIGNER", signerUrl);
    state.txs.push({ step: "signer", hash: signerUrl });
    saveState(state);
  }

  if (should("deliver") && !skipDeliver) {
    if (!state.orderId) {
      console.log("No order yet — skip deliver");
      saveState(state);
      return;
    }
    if (viaAgent) {
      console.log("via-agent: asking runtime to submit_termix_delivery…");
      const beforeAsk = await listConversationMessages(buyer, state.conversationId!);
      const beforeAskCount = beforeAsk.items?.length ?? 0;
      await sendConversationMessage(buyer, state.conversationId!, "请交付", state.buyerAgentId);
      await waitFor("delivery_needs_confirm", async () => {
        const order = await getOrder(buyer, state.orderId!);
        const phase = phaseFromOrderStatus(order.status);
        if (phase === "delivered" || phase === "settled") {
          throw new Error(`Empty delivery submitted on first 请交付 (${order.status})`);
        }
        const msgs = await listConversationMessages(buyer, state.conversationId!);
        const blob = (msgs.items ?? []).slice(beforeAskCount).map(messageText).join("\n");
        if (/没做交易也交付|delivery_needs_confirm|signer page is not a fill|No on-chain DeFi hash/i.test(blob)) {
          console.log("first 请交付 stopped\n", blob.slice(0, 600));
          return blob;
        }
        return undefined;
      });
      await sendConversationMessage(buyer, state.conversationId!, "没做交易也交付", state.buyerAgentId);
      const delivered = await waitFor("agent delivery", async () => {
        const order = await getOrder(buyer, state.orderId!);
        console.log("  order", order.status);
        const phase = phaseFromOrderStatus(order.status);
        return phase === "delivered" || phase === "settled" ? order : undefined;
      });
      console.log("agent delivered", delivered.status);
      saveState(state);
    } else {
      const reportDir = join(dataDir(), "reports");
      mkdirSync(reportDir, { recursive: true });
      const report = buildDeliveryReport({
        title: "bStocks e2e hire delivery",
        userAddress: state.buyerAddress,
        orderId: state.orderId,
        txs: state.txs.map((t) => ({ kind: t.step, hash: t.hash })),
        notes: [
          "This artifact was generated by pnpm termix:e2e-hire.",
          "No user DeFi swap/LP was broadcast in this hire-path test.",
          `Listing ${listingId}. Conversation ${state.conversationId}.`,
        ],
      });
      const md = renderMarkdown(report);
      const file = join(reportDir, `e2e-${state.orderId}.md`);
      writeFileSync(file, md);
      state.reportPath = file;
      const buf = Buffer.from(md);
      const sha = sha256Hex(buf);
      console.log("report", file, "sha256", sha);
      const up = await requestDeliveryUploadUrl(seller, state.orderId, {
        fileName: `e2e-${state.orderId}.md`,
        contentType: "text/markdown",
        sizeBytes: buf.length,
      });
      if (broadcast) {
        await fetch(up.uploadUrl, { method: "PUT", body: buf, headers: { "content-type": "text/markdown" } });
      }
      const art = await registerArtifact(seller, state.orderId, {
        s3Key: up.s3Key,
        url: up.publicUrl ?? up.url ?? up.uploadUrl,
        sha256: sha,
        contentType: "text/markdown",
        sizeBytes: buf.length,
      });
      const intent = await submitDelivery(seller, state.orderId, [art.id], "bStocks e2e hire delivery report");
      const hash = await maybeBroadcast(intent, sellerKey, broadcast, "submitDelivery");
      if (!hash) {
        saveState(state);
        return;
      }
      state.txs.push({ step: "submitDelivery", hash });
      await waitTx(seller, hash, "submitDelivery");
      saveState(state);
    }
  }

  if (should("settle") && !skipSettle) {
    if (!state.orderId) {
      console.log("No order yet — skip settle");
      saveState(state);
      return;
    }
    const order = await getOrder(buyer, state.orderId);
    console.log("order before settle", order.status, "challengeWindowEndsAt", order.challengeWindowEndsAt);
    if (order.status === "SETTLED") {
      console.log("already settled");
    } else {
      try {
        const intent = await prepareBuyerAcceptDelivery(buyer, state.orderId);
        const hash = await maybeBroadcast(intent, buyerKey, broadcast, "releaseEscrow");
        if (!hash) {
          console.log("After --broadcast deliver, buyer can release now or wait 48h and run pnpm termix:claim-watch");
          saveState(state);
          return;
        }
        state.txs.push({ step: "releaseEscrow", hash });
        await waitTx(buyer, hash, "releaseEscrow");
      } catch (e) {
        console.log("buyer release not available yet", e instanceof Error ? e.message : e);
        console.log("If still in challenge window, wait or run: pnpm termix:claim-watch");
      }
    }
    saveState(state);
  }

  if (state.orderId) {
    try {
      const finalOrder = await getOrder(seller, state.orderId);
      console.log("final order", {
        id: finalOrder.id,
        status: finalOrder.status,
        challengeWindowEndsAt: finalOrder.challengeWindowEndsAt,
      });
    } catch {
      /* ignore */
    }
  }

  console.log("done", {
    buyer: state.buyerAddress,
    buyerAgentId: state.buyerAgentId,
    conversationId: state.conversationId,
    offerId: state.offerId,
    checkoutId: state.checkoutId,
    orderId: state.orderId,
    txs: state.txs,
    storefront: "https://www.agent.family/agents/315840",
    inbox: state.conversationId ? `https://www.agent.family/inbox?conversationId=${state.conversationId}` : undefined,
  });
  if (!broadcast) {
    console.log(
      viaAgent
        ? "Dry run finished. Re-run: pnpm termix:e2e-hire -- --via-agent --broadcast --reset"
        : "Dry run finished where on-chain steps begin. Re-run: pnpm termix:e2e-hire -- --broadcast",
    );
  }
}

function buyerAccountSuffix(address: string) {
  return address.slice(-6).toLowerCase();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
