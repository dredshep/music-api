import type { JobStatus, FileStatus } from "../types/api";
import type { SlskdTransferFile } from "../types/upstream";

/**
 * Map slskd compound transfer states to stable public file states.
 *
 * slskd states are typically compound strings like:
 *   "Queued, Remotely"
 *   "InProgress"
 *   "Completed, Succeeded"
 *   "Completed, Aborted"
 *   "Completed, Cancelled"
 *   "Completed, Errored"
 *   "Initializing"
 */
export function mapSlskdFileState(slskdState: string): FileStatus {
  const normalized = slskdState.toLowerCase().replace(/\s/g, "");

  if (normalized.includes("completed,succeeded")) return "completed";
  if (normalized.includes("completed,cancelled")) return "cancelled";
  if (normalized.includes("completed,aborted")) return "failed";
  if (normalized.includes("completed,errored")) return "failed";
  if (normalized.includes("completed,rejected")) return "failed";
  if (normalized.includes("completed,timedout")) return "failed";
  if (normalized.includes("completed")) return "completed";

  if (normalized.includes("inprogress")) return "downloading";
  if (normalized.includes("initializing")) return "downloading";

  if (normalized.includes("queued,locally")) return "queued";
  if (normalized.includes("queued,remotely")) return "waiting_remote";
  if (normalized.includes("queued")) return "queued";

  return "queued";
}

/**
 * Derive overall job status from individual file statuses.
 */
export function deriveJobStatus(fileStatuses: FileStatus[]): JobStatus {
  if (fileStatuses.length === 0) return "queued";

  const counts = {
    queued: 0,
    waiting_remote: 0,
    downloading: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const s of fileStatuses) {
    counts[s]++;
  }

  const total = fileStatuses.length;

  // All completed
  if (counts.completed === total) return "completed";

  // All failed/cancelled
  if (counts.failed + counts.cancelled === total) return "failed";

  // Some completed, some failed, nothing active
  if (
    counts.failed > 0 &&
    counts.queued === 0 &&
    counts.downloading === 0 &&
    counts.waiting_remote === 0
  ) {
    return "partial_failure";
  }

  // Something is actively transferring
  if (counts.downloading > 0 || counts.waiting_remote > 0) return "downloading";

  // Everything is still queued
  if (counts.queued > 0) return "queued";

  return "downloading";
}

/**
 * Compute aggregate progress for a job.
 */
export function computeProgress(files: { status: FileStatus; size?: number }[]): number {
  if (files.length === 0) return 0;

  const total = files.length;
  const completed = files.filter((f) => f.status === "completed").length;

  return completed / total;
}

/**
 * Determine human-readable error reason from slskd state.
 */
export function mapTransferError(slskdState: string): string {
  const normalized = slskdState.toLowerCase();

  if (normalized.includes("aborted")) return "transfer_aborted";
  if (normalized.includes("rejected")) return "peer_rejected";
  if (normalized.includes("timedout")) return "timeout";
  if (normalized.includes("errored")) return "transfer_error";
  if (normalized.includes("cancelled")) return "cancelled";

  return "unknown_error";
}

/**
 * Check if a transfer should be retried.
 */
export function isRetryable(fileStatus: FileStatus): boolean {
  return fileStatus === "failed" || fileStatus === "cancelled";
}
