import { getDb } from "../database";
import { ulid } from "ulid";
import type { FileKind, FileStatus } from "../../types/api";

export interface JobFileRecord {
  id: string;
  job_id: string;
  logical_filename: string;
  remote_filename: string;
  size: number | null;
  kind: string;
  original_peer: string | null;
  current_peer: string | null;
  slskd_transfer_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobFileParams {
  jobId: string;
  logicalFilename: string;
  remoteFilename: string;
  size?: number;
  kind: FileKind;
  peer: string;
}

export function createJobFile(params: CreateJobFileParams): JobFileRecord {
  const db = getDb();
  const id = `file_${ulid()}`;
  const now = new Date().toISOString();

  const record: JobFileRecord = {
    id,
    job_id: params.jobId,
    logical_filename: params.logicalFilename,
    remote_filename: params.remoteFilename,
    size: params.size ?? null,
    kind: params.kind,
    original_peer: params.peer,
    current_peer: params.peer,
    slskd_transfer_id: null,
    status: "queued",
    attempts: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };

  db.query(`
    INSERT INTO download_job_files (
      id, job_id, logical_filename, remote_filename, size, kind,
      original_peer, current_peer, slskd_transfer_id, status, attempts,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.job_id,
    record.logical_filename,
    record.remote_filename,
    record.size,
    record.kind,
    record.original_peer,
    record.current_peer,
    record.slskd_transfer_id,
    record.status,
    record.attempts,
    record.last_error,
    record.created_at,
    record.updated_at
  );

  return record;
}

export function createJobFiles(files: CreateJobFileParams[]): JobFileRecord[] {
  return files.map((f) => createJobFile(f));
}

export function getJobFiles(jobId: string): JobFileRecord[] {
  const db = getDb();
  return db
    .query<JobFileRecord, [string]>(
      "SELECT * FROM download_job_files WHERE job_id = ? ORDER BY logical_filename"
    )
    .all(jobId);
}

export function getJobFile(id: string): JobFileRecord | null {
  const db = getDb();
  return (
    db
      .query<JobFileRecord, [string]>(
        "SELECT * FROM download_job_files WHERE id = ?"
      )
      .get(id) ?? null
  );
}

export function getFailedJobFiles(jobId: string): JobFileRecord[] {
  const db = getDb();
  return db
    .query<JobFileRecord, [string]>(
      "SELECT * FROM download_job_files WHERE job_id = ? AND status = 'failed'"
    )
    .all(jobId);
}

export function getRetryableJobFiles(jobId: string): JobFileRecord[] {
  const db = getDb();
  return db
    .query<JobFileRecord, [string]>(
      "SELECT * FROM download_job_files WHERE job_id = ? AND status IN ('failed', 'cancelled')"
    )
    .all(jobId);
}

export function updateJobFileStatus(
  id: string,
  status: FileStatus,
  error?: string
): void {
  const db = getDb();
  db.query(
    "UPDATE download_job_files SET status = ?, last_error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?"
  ).run(status, error ?? null, new Date().toISOString(), id);
}

/** Mark every file on a job failed (e.g. enqueue rejected before any transfer started). */
export function failAllJobFiles(jobId: string, error: string): number {
  const db = getDb();
  const result = db
    .query(
      `UPDATE download_job_files
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('queued', 'waiting_remote', 'downloading')`
    )
    .run(error, new Date().toISOString(), jobId);
  return Number(result.changes ?? 0);
}

export function updateJobFileTransferId(
  id: string,
  transferId: string
): void {
  const db = getDb();
  db.query(
    "UPDATE download_job_files SET slskd_transfer_id = ?, updated_at = ? WHERE id = ?"
  ).run(transferId, new Date().toISOString(), id);
}

/** Update status/transfer id from slskd sync without bumping attempt count. */
export function syncJobFileFromTransfer(
  id: string,
  params: {
    status: FileStatus;
    transferId?: string | null;
    error?: string | null;
  }
): void {
  const db = getDb();
  db.query(
    `UPDATE download_job_files
     SET status = ?,
         slskd_transfer_id = COALESCE(?, slskd_transfer_id),
         last_error = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    params.status,
    params.transferId ?? null,
    params.error ?? null,
    new Date().toISOString(),
    id
  );
}

export function updateJobFilePeer(id: string, peer: string): void {
  const db = getDb();
  db.query(
    "UPDATE download_job_files SET current_peer = ?, updated_at = ? WHERE id = ?"
  ).run(peer, new Date().toISOString(), id);
}

export function getJobFileStats(jobId: string): {
  total: number;
  queued: number;
  downloading: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  const db = getDb();
  const rows = db
    .query<{ status: string; cnt: number }, [string]>(
      "SELECT status, COUNT(*) as cnt FROM download_job_files WHERE job_id = ? GROUP BY status"
    )
    .all(jobId);

  const stats = { total: 0, queued: 0, downloading: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    stats.total += row.cnt;
    const key = row.status as keyof typeof stats;
    if (key in stats && key !== "total") {
      stats[key] = row.cnt;
    }
  }
  // waiting_remote counts as downloading for summary
  const waitingRemote = rows.find((r) => r.status === "waiting_remote");
  if (waitingRemote) {
    stats.downloading += waitingRemote.cnt;
    stats.total += waitingRemote.cnt;
  }

  return stats;
}
