import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { RiskConfig } from "./types.js";

function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

export function loadRiskConfig(): RiskConfig {
  return JSON.parse(readFileSync(join(findRepoRoot(), "config", "risk.json"), "utf8")) as RiskConfig;
}
