import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NextConfig } from "next";

/**
 * Local only. `next build` / Vercel are NODE_ENV=production and must not ingest
 * the repo-root .env (localhost RUNTIME_* would get inlined into the client).
 */
function loadRepoEnvForDev() {
  if (process.env.NODE_ENV !== "development") return;
  const p = join(resolve(process.cwd(), "../.."), ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadRepoEnvForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
