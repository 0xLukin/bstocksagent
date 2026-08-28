/**
 * Interactive local chat against a running Runtime (POST /chat).
 * Start `pnpm dev:runtime` first.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const base = process.env.RUNTIME_PUBLIC_URL ?? "http://127.0.0.1:8787";
const conversationId = process.argv[2] ?? "local";

async function send(text: string) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, text }),
  });
  const json = (await res.json()) as { reply?: string; error?: string; state?: unknown };
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  console.log("\n--- Agent ---\n" + (json.reply ?? "") + "\n");
}

async function main() {
  console.log(`Local Termix chat → ${base}/chat  conversation=${conversationId}`);
  console.log("Examples: I confirm I am not in the United States or a restricted region / 0x… / quote USDT→NVDAB 10 / confirm");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (/^(exit|quit|q)$/i.test(line)) break;
      await send(line);
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
