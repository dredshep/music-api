import { getDb } from "./database";
import { log } from "../middleware/logging";

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function runCleanup(): void {
  const db = getDb();
  const now = new Date().toISOString();

  const expiredSearches = db
    .query("DELETE FROM candidates WHERE expires_at < ?")
    .run(now);
  const expiredSearchRows = db
    .query("DELETE FROM searches WHERE expires_at < ?")
    .run(now);
  const expiredCache = db
    .query("DELETE FROM cache WHERE expires_at < ?")
    .run(now);

  const totalCleaned =
    expiredSearches.changes + expiredSearchRows.changes + expiredCache.changes;

  if (totalCleaned > 0) {
    log("info", "ttl_cleanup", {
      candidates_removed: expiredSearches.changes,
      searches_removed: expiredSearchRows.changes,
      cache_removed: expiredCache.changes,
    });
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  log("info", "cleanup_timer_started", { interval_ms: CLEANUP_INTERVAL_MS });
}

export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
