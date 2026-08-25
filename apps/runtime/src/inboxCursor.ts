import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadInboxSince(dataDir: string): string {
  const p = join(dataDir, "a2a-cursor.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { since?: string };
      if (j.since) return j.since;
    } catch {
      /* start fresh */
    }
  }
  return new Date(Date.now() - 60_000).toISOString();
}

export function saveInboxSince(dataDir: string, since: string) {
  writeFileSync(
    join(dataDir, "a2a-cursor.json"),
    JSON.stringify({ since, updatedAt: new Date().toISOString() }, null, 2),
  );
}
