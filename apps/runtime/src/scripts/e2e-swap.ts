/**
 * User-wallet swap path: geo → buyer address → 0.01 USDC → NVDAB → signer page.
 * Does not broadcast the swap. The user signs on the signer page.
 *
 *   pnpm termix:e2e-swap
 *   pnpm termix:e2e-swap -- --via termix
 */
import { privateKeyToAccount } from "viem/accounts";
import { loadRepoEnv } from "@bstocks/chain";
import {
  buyerWalletKeyOrNull,
  listConversationMessages,
  sendConversationMessage,
  TermixClient,
  walletLogin,
} from "@bstocks/termix";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@bstocks/chain";

loadRepoEnv();

const BUY_TEXT = "用 0.01 USDC 买英伟达";
const SIGNER_RE = /https?:\/\/[^\s)`'"<>]+\/t\/[A-Za-z0-9_-]+/g;

function hireState() {
  const dir = process.env.DATA_DIR?.startsWith("/")
    ? process.env.DATA_DIR
    : join(findRepoRoot(), process.env.DATA_DIR ?? ".data");
  const p = join(dir, "e2e-hire.json");
  if (!existsSync(p)) return {} as Record<string, string>;
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
}

function pickSigner(text: string): string | undefined {
  return text.match(SIGNER_RE)?.[0];
}

async function chat(base: string, conversationId: string, text: string) {
  const res = await fetch(`${base.replace(/\/$/, "")}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, text }),
  });
  const json = (await res.json()) as { reply?: string; error?: string; state?: { lastIntent?: { signerUrl?: string } } };
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  console.log(`\n> ${text}\n---\n${json.reply ?? ""}\n`);
  return json;
}

async function viaChat(buyer: string) {
  const base = process.env.RUNTIME_PUBLIC_URL ?? "http://127.0.0.1:8787";
  const conversationId = `e2e-swap-${Date.now()}`;
  console.log("swap via POST /chat", base, "conversation", conversationId);
  await chat(base, conversationId, "I confirm I am not in the United States or a restricted region.");
  await chat(base, conversationId, buyer);
  const quoted = await chat(base, conversationId, BUY_TEXT);
  const confirmed = await chat(base, conversationId, "确认执行");
  const url =
    confirmed.state?.lastIntent?.signerUrl ??
    pickSigner(confirmed.reply ?? "") ??
    quoted.state?.lastIntent?.signerUrl ??
    pickSigner(quoted.reply ?? "");
  if (!url) throw new Error("Runtime did not return a signer URL");
  console.log("SIGNER", url);
  return url;
}

function messageText(row: Record<string, unknown>): string {
  return typeof row.text === "string" ? row.text : "";
}

async function viaTermix(buyer: string) {
  const key = buyerWalletKeyOrNull();
  if (!key) throw new Error("BUYER_WALLET_KEY required for --via termix");
  const conversationId = process.env.TERMIX_CONVERSATION_ID ?? hireState().conversationId;
  const buyerAgentId = process.env.TERMIX_BUYER_AGENT_ID ?? hireState().buyerAgentId;
  if (!conversationId) throw new Error("No conversationId. Run termix:e2e-hire first or set TERMIX_CONVERSATION_ID.");
  const client = new TermixClient();
  await walletLogin(client, key);
  const before = await listConversationMessages(client, conversationId);
  const beforeCount = before.items?.length ?? 0;
  console.log("swap via Termix inbox", conversationId);

  const send = async (text: string) => {
    await sendConversationMessage(client, conversationId, text, buyerAgentId);
    console.log("sent", text);
  };
  await send(buyer);
  await send(BUY_TEXT);

  let quoteReply = "";
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const msgs = await listConversationMessages(client, conversationId);
    const fresh = (msgs.items ?? []).slice(beforeCount).filter((m) => messageText(m).length > 20);
    const agentish = fresh.find((m) => /NVDAB|英伟达|signer|确认|USDC|报价/i.test(messageText(m)));
    if (agentish) {
      quoteReply = messageText(agentish);
      console.log("agent quote\n", quoteReply.slice(0, 800));
      break;
    }
    console.log("waiting for quote", i + 1);
  }
  if (!quoteReply) throw new Error("No A2A quote in Termix inbox");

  const afterQuote = (await listConversationMessages(client, conversationId)).items?.length ?? 0;
  await send("确认执行");
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const msgs = await listConversationMessages(client, conversationId);
    const fresh = (msgs.items ?? []).slice(afterQuote);
    const url =
      pickSigner(fresh.map(messageText).join("\n")) ??
      (fresh.map((m) => (m as { lastIntent?: { signerUrl?: string } }).lastIntent?.signerUrl).find(Boolean) as
        | string
        | undefined);
    if (url) {
      console.log("SIGNER", url);
      return url;
    }
    const text = fresh.map(messageText).filter(Boolean).pop();
    if (text) console.log("agent after confirm\n", text.slice(0, 800));
    if (text && /signer|确认执行|intent/i.test(text) && pickSigner(text)) {
      const found = pickSigner(text)!;
      console.log("SIGNER", found);
      return found;
    }
    console.log("waiting for signer", i + 1);
  }
  throw new Error("A2A did not send a signer URL. Check VPS runtime logs.");
}

async function main() {
  const via = process.argv.includes("--via")
    ? process.argv[process.argv.indexOf("--via") + 1]
    : process.argv.includes("--via-termix")
      ? "termix"
      : "chat";
  const key = buyerWalletKeyOrNull();
  if (!key) throw new Error("BUYER_WALLET_KEY is empty");
  const buyer = privateKeyToAccount(key).address;
  console.log("buyer", buyer, "buy", BUY_TEXT);
  const url = via === "termix" ? await viaTermix(buyer) : await viaChat(buyer);
  console.log("\nOpen this signer page, connect the buyer wallet, review, then sign if you want the swap on-chain.");
  console.log(url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
