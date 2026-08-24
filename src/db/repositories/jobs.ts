import { getDb } from "../database";
import { ulid } from "ulid";
import type { JobStatus } from "../../types/api";

export interface JobRecord {
  id: string;
  candidate_id: string | null;
  artist: string | null;
  release_title: string | null;
  release_type: string | null;
  musicbrainz_release_group_id: string | null;
  selected_format: string | null;
  original_query_json: string | null;
  edition_hints_json: string | null;
  peer: string | null;
  remote_directory: string | null;
  status: string;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobParams {
  candidateId: string;
  artist?: string;
  releaseTitle?: string;
  releaseType?: string;
  musicbrainzReleaseGroupId?: string;
  selectedFormat?: string;
  originalQuery?: unknown;
  editionHints?: unknown;
  peer: string;
  remoteDirectory: string;
}

export function createJob(params: CreateJobParams): JobRecord {
  const db = getDb();
  const id = `job_${ulid()}`;
  const now = new Date().toISOString();

  const record: JobRecord = {
    id,
    candidate_id: params.candidateId,
    artist: params.artist ?? null,
    release_title: params.releaseTitle ?? null,
    release_type: params.releaseType ?? null,
    musicbrainz_release_group_id: params.musicbrainzReleaseGroupId ?? null,
    selected_format: params.selectedFormat ?? null,
    original_query_json: params.originalQuery
      ? JSON.stringify(params.originalQuery)
      : null,
    edition_hints_json: params.editionHints
      ? JSON.stringify(params.editionHints)
      : null,
    peer: params.peer,
    remote_directory: params.remoteDirectory,
    status: "queued",
    attempt: 1,
    last_error: null,
    created_at: now,
    updated_at: now,
  };

  db.query(`
    INSERT INTO download_jobs (
      id, candidate_id, artist, release_title, release_type,
      musicbrainz_release_group_id, selected_format, original_query_json,
      edition_hints_json, peer, remote_directory, status, attempt,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.candidate_id,
    record.artist,
    record.release_title,
    record.release_type,
    record.musicbrainz_release_group_id,
    record.selected_format,
    record.original_query_json,
    record.edition_hints_json,
    record.peer,
    record.remote_directory,
    record.status,
    record.attempt,
    record.last_error,
    record.created_at,
    record.updated_at
  );

  return record;
}

export function getJob(id: string): JobRecord | null {
  const db = getDb();
  return (
    db
      .query<JobRecord, [string]>("SELECT * FROM download_jobs WHERE id = ?")
      .get(id) ?? null
  );
}

export function getJobByCandidateId(candidateId: string): JobRecord | null {
  const db = getDb();
  return (
    db
      .query<JobRecord, [string]>(
        "SELECT * FROM download_jobs WHERE candidate_id = ? AND status NOT IN ('cancelled', 'failed')"
      )
      .get(candidateId) ?? null
  );
}

export function listJobs(params: {
  status?: string;
  limit?: number;
  artist?: string;
  release?: string;
  q?: string;
  sinceDays?: number;
}): JobRecord[] {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (params.status && params.status !== "all") {
    if (params.status === "active") {
      conditions.push("status IN ('queued', 'downloading', 'retrying')");
    } else {
      conditions.push("status = ?");
      bindings.push(params.status);
    }
  }

  if (params.artist?.trim()) {
    conditions.push("instr(lower(COALESCE(artist, '')), lower(?)) > 0");
    bindings.push(params.artist.trim());
  }

  if (params.release?.trim()) {
    conditions.push("instr(lower(COALESCE(release_title, '')), lower(?)) > 0");
    bindings.push(params.release.trim());
  }

  if (params.q?.trim()) {
    conditions.push(
      "(instr(lower(COALESCE(artist, '')), lower(?)) > 0 OR instr(lower(COALESCE(release_title, '')), lower(?)) > 0)"
    );
    const term = params.q.trim();
    bindings.push(term, term);
  }

  if (params.sinceDays != null && params.sinceDays > 0) {
    conditions.push("created_at >= datetime('now', ?)");
    bindings.push(`-${Math.floor(params.sinceDays)} days`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM download_jobs ${where} ORDER BY created_at DESC LIMIT ?`;
  bindings.push(limit);

  return db.query<JobRecord, (string | number)[]>(sql).all(...bindings);
}

export function updateJobStatus(
  id: string,
  status: JobStatus,
  lastError?: string | null
): void {
  const db = getDb();
  if (lastError !== undefined) {
    db.query(
      "UPDATE download_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?"
    ).run(status, lastError, new Date().toISOString(), id);
  } else {
    db.query(
      "UPDATE download_jobs SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, new Date().toISOString(), id);
  }
}

export function incrementJobAttempt(id: string): void {
  const db = getDb();
  db.query(
    "UPDATE download_jobs SET attempt = attempt + 1, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), id);
}
