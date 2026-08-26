/**
 * Periodic download reconciliation service.
 *
 * Inspects active logical jobs, syncs them against slskd's real
 * transfer state, and applies bounded automatic recovery for
 * failed/timed-out/missing transfers.
 */

import { log } from "../middleware/logging";
import { listJobs, getJob, updateJobStatus } from "../db/repositories/jobs";
import {
  getJobFiles,
  updateJobFileStatus,
  getRetryableJobFiles,
  syncJobFileFromTransfer,
} from "../db/repositories/job-files";
import { syncActiveJobsFromSlskd } from "../domain/sync-transfers";
import { deriveJobStatus } from "../domain/transfers";
import * as slskd from "./slskd";
import type { FileStatus } from "../types/api";

const RECONCILE_INTERVAL_MS = 30_000;
const MAX_FILE_RETRY_ATTEMPTS = 3;
const MISSING_TRANSFER_THRESHOLD_MS = 5 * 60 * 1000;

let reconcilerTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationRunning = false;

export function startReconciler(): void {
  if (reconcilerTimer) return;

  reconcilerTimer = setInterval(async () => {
    if (reconciliationRunning) {
      log("info", "reconciler_round_skipped", { reason: "previous_round_still_running" });
      return;
    }

    reconciliationRunning = true;
    try {
      await runReconciliation();
    } catch (err) {
      log("warn", "reconciler_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reconciliationRunning = false;
    }
  }, RECONCILE_INTERVAL_MS);

  log("info", "reconciler_started", { interval_ms: RECONCILE_INTERVAL_MS });
}

export function stopReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
  reconciliationRunning = false;
}

async function runReconciliation(): Promise<void> {
  const synced = await syncActiveJobsFromSlskd();

  if (synced > 0) {
    log("info", "reconciler_sync_completed", { jobs_updated: synced });
  }

  // First convert impossible long-lived queued rows into explicit failures.
  // This handles the "job exists in music-api but nothing exists in slskd"
  // case instead of leaving the UI permanently stuck on queued.
  const activeJobs = listJobs({ status: "active", limit: 100 });
  for (const job of activeJobs) {
    detectMissingTransfers(job.id);
  }

  // Then retry bounded transient failures, including freshly-detected ghosts.
  const failedJobs = listJobs({ status: "failed", limit: 50 });
  const partialJobs = listJobs({ status: "partial_failure", limit: 50 });

  const retryableJobs = [...failedJobs, ...partialJobs].filter((job) => {
    const files = getRetryableJobFiles(job.id);
    return files.some(
      (f) => f.attempts < MAX_FILE_RETRY_ATTEMPTS && isAutoRetryable(f.last_error)
    );
  });

  for (const job of retryableJobs) {
    try {
      await retryFailedFiles(job.id);
    } catch (err) {
      log("warn", "reconciler_retry_error", {
        job_id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isAutoRetryable(error: string | null): boolean {
  if (!error) return false;
  return [
    "timeout",
    "transfer_error",
    "transfer_aborted",
    "missing_transfer",
  ].includes(error);
}

async function retryFailedFiles(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.peer) return;

  const retryable = getRetryableJobFiles(jobId).filter(
    (f) =>
      f.attempts < MAX_FILE_RETRY_ATTEMPTS &&
      isAutoRetryable(f.last_error)
  );

  if (retryable.length === 0) return;

  const filesToRetry = retryable.map((f) => ({
    filename: f.remote_filename,
    size: f.size ?? 0,
  }));

  try {
    await slskd.enqueueFiles(job.peer, filesToRetry);

    for (const file of retryable) {
      // updateJobFileStatus intentionally increments attempts here: each
      // successful re-enqueue consumes one retry budget slot.
      updateJobFileStatus(file.id, "queued" as FileStatus);
    }

    if (job.status !== "downloading") {
      updateJobStatus(jobId, "downloading", null);
    }

    log("info", "reconciler_retry_enqueued", {
      job_id: jobId,
      files_retried: retryable.length,
      peer: job.peer,
    });
  } catch (err) {
    log("warn", "reconciler_retry_enqueue_failed", {
      job_id: jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function detectMissingTransfers(jobId: string): void {
  const files = getJobFiles(jobId);
  const now = Date.now();
  let changed = false;

  for (const file of files) {
    if (file.status !== "queued") continue;
    if (!file.created_at || file.slskd_transfer_id) continue;

    const createdAt = new Date(file.created_at).getTime();
    if (!Number.isFinite(createdAt)) continue;
    const elapsed = now - createdAt;

    if (elapsed > MISSING_TRANSFER_THRESHOLD_MS) {
      // Do not bump attempts merely for detecting the missing transfer. The
      // retry attempt is counted only once the re-enqueue actually happens.
      syncJobFileFromTransfer(file.id, {
        status: "failed",
        transferId: null,
        error: "missing_transfer",
      });
      changed = true;

      log("warn", "reconciler_missing_transfer", {
        job_id: jobId,
        file_id: file.id,
        filename: file.logical_filename,
        elapsed_ms: elapsed,
      });
    }
  }

  if (!changed) return;

  const refreshed = getJobFiles(jobId);
  const nextStatus = deriveJobStatus(
    refreshed.map((file) => file.status as FileStatus)
  );
  updateJobStatus(jobId, nextStatus, nextStatus === "failed" ? "missing_transfer" : null);
}
