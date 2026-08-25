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
  console.log(`本地 Termix 开发对话 → ${base}/chat  conversation=${conversationId}`);
  console.log("例句：我确认不在美国及受限地区 / 0x你的地址 / 报价 USDT→NVDAB 10 / 确认执行");
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
