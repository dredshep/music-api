import { log } from "../middleware/logging";
import * as slskd from "../services/slskd";
import type { SlskdTransferFile } from "../types/upstream";
import type { FileStatus, JobStatus } from "../types/api";
import {
  mapSlskdFileState,
  mapTransferError,
  deriveJobStatus,
} from "./transfers";
import { getJob, listJobs, updateJobStatus } from "../db/repositories/jobs";
import {
  getJobFiles,
  syncJobFileFromTransfer,
  type JobFileRecord,
} from "../db/repositories/job-files";
import { getFilename } from "./candidates";

type TransferIndex = Map<string, SlskdTransferFile>;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function transferKeys(peer: string, filename: string): string[] {
  const full = `${peer.toLowerCase()}::${normalizePath(filename)}`;
  const base = `${peer.toLowerCase()}::basename::${getFilename(filename).toLowerCase()}`;
  return [full, base];
}

function buildTransferIndex(
  downloads: Awaited<ReturnType<typeof slskd.getDownloads>>
): TransferIndex {
  const index: TransferIndex = new Map();

  for (const user of downloads) {
    for (const dir of user.directories ?? []) {
      for (const file of dir.files ?? []) {
        for (const key of transferKeys(user.username, file.filename)) {
          const existing = index.get(key);
          if (!existing) {
            index.set(key, file);
            continue;
          }
          const existingDone = mapSlskdFileState(existing.state) === "completed";
          const nextDone = mapSlskdFileState(file.state) === "completed";
          if (!existingDone && nextDone) {
            index.set(key, file);
          }
        }
      }
    }
  }

  return index;
}

function findTransfer(
  index: TransferIndex,
  peer: string | null,
  remoteFilename: string
): SlskdTransferFile | undefined {
  if (!peer) return undefined;
  for (const key of transferKeys(peer, remoteFilename)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return undefined;
}

function applyTransferToFile(
  file: JobFileRecord,
  transfer: SlskdTransferFile
): { changed: boolean; status: FileStatus } {
  const status = mapSlskdFileState(transfer.state);
  const error =
    status === "failed" || status === "cancelled"
      ? mapTransferError(transfer.state)
      : null;

  const changed =
    file.status !== status ||
    file.slskd_transfer_id !== transfer.id ||
    (error !== null && file.last_error !== error);

  if (changed) {
    syncJobFileFromTransfer(file.id, {
      status,
      transferId: transfer.id,
      error,
    });
  }

  return { changed, status };
}

export interface SyncedJobSnapshot {
  jobId: string;
  status: JobStatus;
  filesUpdated: number;
  fileStatuses: FileStatus[];
}

/**
 * Reconcile one job's file rows against live slskd transfer state.
 */
export async function syncJobFromSlskd(jobId: string): Promise<SyncedJobSnapshot | null> {
  const job = getJob(jobId);
  if (!job) return null;

  // Terminal jobs with no active files skip the round-trip
  if (job.status === "failed" || job.status === "cancelled" || job.status === "completed") {
    const files = getJobFiles(jobId);
    const active = files.some(
      (f) =>
        f.status === "queued" ||
        f.status === "downloading" ||
        f.status === "waiting_remote"
    );
    if (!active) {
      return {
        jobId,
        status: job.status as JobStatus,
        filesUpdated: 0,
        fileStatuses: files.map((f) => f.status as FileStatus),
      };
    }
  }

  const downloads = await slskd.getDownloads();
  const index = buildTransferIndex(downloads);
  return reconcileJob(jobId, index);
}

/**
 * Sync all active jobs against a single slskd downloads snapshot.
 */
export async function syncActiveJobsFromSlskd(): Promise<number> {
  const jobs = listJobs({ status: "active", limit: 200 });
  if (jobs.length === 0) return 0;

  const downloads = await slskd.getDownloads();
  const index = buildTransferIndex(downloads);

  let updatedJobs = 0;
  for (const job of jobs) {
    const snap = reconcileJob(job.id, index);
    if (snap && snap.filesUpdated > 0) updatedJobs++;
  }

  return updatedJobs;
}

function reconcileJob(jobId: string, index: TransferIndex): SyncedJobSnapshot | null {
  const job = getJob(jobId);
  if (!job) return null;

  const files = getJobFiles(jobId);
  let filesUpdated = 0;
  const statuses: FileStatus[] = [];

  for (const file of files) {
    const transfer = findTransfer(
      index,
      file.current_peer ?? job.peer,
      file.remote_filename
    );

    if (!transfer) {
      statuses.push(file.status as FileStatus);
      continue;
    }

    const { changed, status } = applyTransferToFile(file, transfer);
    if (changed) filesUpdated++;
    statuses.push(status);
  }

  const nextStatus = deriveJobStatus(statuses);
  if (nextStatus !== job.status) {
    updateJobStatus(jobId, nextStatus);
    filesUpdated++;
  }

  if (filesUpdated > 0) {
    log("info", "download_job_synced", {
      job_id: jobId,
      status: nextStatus,
      files_updated: filesUpdated,
      completed: statuses.filter((s) => s === "completed").length,
      total: statuses.length,
    });
  }

  return {
    jobId,
    status: nextStatus,
    filesUpdated,
    fileStatuses: statuses,
  };
}
