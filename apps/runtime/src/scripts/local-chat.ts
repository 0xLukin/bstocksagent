/**
 * Interactive local chat against a running Runtime (POST /chat).
 * Start `pnpm dev:runtime` first.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadRepoEnv } from "@bstocks/chain";

loadRepoEnv();

const base = process.env.RUNTIME_PUBLIC_URL ?? "http://127.0.0.1:8787";
const conversationId = process.argv[2] ?? "local";

async function send(text: string) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, text }),
  });
  const raw = await res.text();
  let json: { reply?: string; error?: string; state?: unknown };
  try {
    json = JSON.parse(raw) as { reply?: string; error?: string; state?: unknown };
  } catch {
    throw new Error(`Runtime ${res.status} (not JSON): ${raw.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(json.error ?? json.reply ?? res.statusText);
  console.log("\n--- Agent ---\n" + (json.reply ?? "") + "\n");
}

async function main() {
  console.log(`Local Termix chat → ${base}/chat  conversation=${conversationId}`);
  console.log("Examples: 我确认不在美国及受限地区 / 0x… / 查询一下nvdab的报价 / 用 10 USDT 买英伟达 / 确认执行");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (/^(exit|quit|q)$/i.test(line)) break;
      try {
        await send(line);
      } catch (err) {
        console.error("\n--- Error ---\n" + (err instanceof Error ? err.message : String(err)) + "\n");
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
