import { getDb } from "./database";
import { log } from "../middleware/logging";

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Prune stale candidate snapshots and generic cache entries.
 *
 * Searches themselves are DURABLE and never deleted by TTL cleanup.
 * Only candidate rows (refreshable snapshots) and generic cache entries
 * are pruned. The search identity and its variant mappings persist
 * indefinitely so that cross-client/cross-restart search reuse works.
 */
export function runCleanup(): void {
  const db = getDb();
  const now = new Date().toISOString();

  const expiredCandidates = db
    .query("DELETE FROM candidates WHERE expires_at < ?")
    .run(now);
  const expiredCache = db
    .query("DELETE FROM cache WHERE expires_at < ?")
    .run(now);

  const totalCleaned = expiredCandidates.changes + expiredCache.changes;

  if (totalCleaned > 0) {
    log("info", "ttl_cleanup", {
      candidates_removed: expiredCandidates.changes,
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
