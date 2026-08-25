import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findRepoRoot(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find monorepo root (pnpm-workspace.yaml)");
    }
    dir = parent;
  }
}

export function configPath(name: "tokens.json" | "pools.json" | "risk.json"): string {
  return join(findRepoRoot(), "config", name);
}
