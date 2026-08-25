import { readFileSync } from "node:fs";
import { loadRepoEnv } from "@bstocks/chain";
import {
  broadcastIntent,
  registerArtifact,
  requestDeliveryUploadUrl,
  sha256Hex,
  submitDelivery,
  TermixClient,
  walletLogin,
} from "@bstocks/termix";

loadRepoEnv();

async function main() {
  const orderId = process.argv[2];
  const filePath = process.argv[3];
  const dry = !process.argv.includes("--broadcast");
  if (!orderId || !filePath) {
    console.log("Usage: pnpm termix:deliver -- <orderId> <report.md> [--broadcast]");
    return;
  }
  const buf = readFileSync(filePath);
  const sha = sha256Hex(buf);
  console.log("artifact", { filePath, bytes: buf.length, sha256: sha });
  if (!process.env.WALLET_KEY) {
    console.log("WALLET_KEY missing — stopping before upload.");
    return;
  }
  const client = new TermixClient();
  await walletLogin(client);
  const up = await requestDeliveryUploadUrl(client, orderId, {
    fileName: filePath.split("/").pop() ?? "report.md",
    contentType: "text/markdown",
    sizeBytes: buf.length,
  });
  if (!dry) {
    await fetch(up.uploadUrl, { method: "PUT", body: buf, headers: { "content-type": "text/markdown" } });
  }
  const url = up.publicUrl ?? up.url ?? up.uploadUrl;
  const art = await registerArtifact(client, orderId, {
    s3Key: up.s3Key,
    url,
    sha256: sha,
    contentType: "text/markdown",
    sizeBytes: buf.length,
  });
  console.log("registered", art);
  const intent = await submitDelivery(client, orderId, [art.id], "bStocks / Pancake V3 交付报告");
  console.log("submit intent", intent.action, intent.chainId);
  if (dry) {
    console.log("Dry run (upload skipped unless --broadcast). Pass --broadcast to send submitDelivery.");
    return;
  }
  const hash = await broadcastIntent(intent);
  console.log("submitDelivery tx", hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
