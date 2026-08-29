/**
 * Standalone cron: claimAfterTimeout for DELIVERED orders past challengeWindowEndsAt.
 * Termix has no auto-settle worker — you must run this (or the runtime watchdog).
 */
import { loadRepoEnv } from "@bstocks/chain";
import { startOrderWatchdog } from "../watchdog.js";

loadRepoEnv();

console.log("claimAfterTimeout watchdog starting. Ctrl+C to stop.");
startOrderWatchdog(undefined, 30_000);
