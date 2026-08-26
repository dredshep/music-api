/**
 * Periodic download reconciliation service.
 *
 * Inspects active logical jobs, syncs them against slskd's real
 * transfer state, and applies bounded automatic recovery for
 * failed/timed-out transfers.
 */

import { log } from "../middleware/logging";
import { listJobs, getJob, updateJobStatus } from "../db/repositories/jobs";
import {
  getJobFiles,
  updateJobFileStatus,
  getRetryableJobFiles,
} from "../db/repositories/job-files";
import { syncActiveJobsFromSlskd, syncJobFromSlskd } from "../domain/sync-transfers";
import * as slskd from "./slskd";
import type { FileStatus } from "../types/api";

const RECONCILE_INTERVAL_MS = 30_000;
const MAX_FILE_RETRY_ATTEMPTS = 3;

let reconcilerTimer: ReturnType<typeof setInterval> | null = null;

export function startReconciler(): void {
  if (reconcilerTimer) return;

  reconcilerTimer = setInterval(async () => {
    try {
      await runReconciliation();
    } catch (err) {
      log("warn", "reconciler_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, RECONCILE_INTERVAL_MS);

  log("info", "reconciler_started", { interval_ms: RECONCILE_INTERVAL_MS });
}

export function stopReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
}

async function runReconciliation(): Promise<void> {
  const synced = await syncActiveJobsFromSlskd();

  if (synced > 0) {
    log("info", "reconciler_sync_completed", { jobs_updated: synced });
  }

  // Check for jobs with retryable file failures
  const activeJobs = listJobs({ status: "active", limit: 100 });
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

  // Detect jobs stuck in "queued" with no slskd transfer after a threshold
  for (const job of activeJobs) {
    detectMissingTransfers(job.id);
  }
}

function isAutoRetryable(error: string | null): boolean {
  if (!error) return false;
  const retryableErrors = [
    "timeout",
    "transfer_error",
    "transfer_aborted",
  ];
  return retryableErrors.includes(error);
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
      updateJobFileStatus(file.id, "queued" as FileStatus);
    }

    if (job.status !== "downloading") {
      updateJobStatus(jobId, "downloading");
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
  const staleThresholdMs = 5 * 60 * 1000;

  for (const file of files) {
    if (file.status !== "queued") continue;
    if (!file.created_at) continue;

    const createdAt = new Date(file.created_at).getTime();
    const elapsed = now - createdAt;

    if (elapsed > staleThresholdMs && !file.slskd_transfer_id) {
      log("info", "reconciler_missing_transfer", {
        job_id: jobId,
        file_id: file.id,
        filename: file.logical_filename,
        elapsed_ms: elapsed,
      });
    }
  }
}
