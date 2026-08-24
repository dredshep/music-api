import { getDb } from "../database";
import { ulid } from "ulid";

export interface CandidateRecord {
  id: string;
  search_id: string;
  peer: string;
  remote_directory: string;
  display_release: string | null;
  format: string | null;
  track_count: number | null;
  audio_file_count: number | null;
  lrc_count: number | null;
  image_count: number | null;
  sidecar_count: number | null;
  lrc_coverage: number | null;
  total_bytes: number | null;
  upload_speed: number | null;
  free_upload_slots: number | null;
  queue_length: number | null;
  score: number | null;
  reason: string | null;
  flags_json: string | null;
  files_json: string | null;
  raw_json: string | null;
  created_at: string;
  expires_at: string;
}

export interface CreateCandidateParams {
  searchId: string;
  peer: string;
  remoteDirectory: string;
  displayRelease?: string;
  format?: string;
  trackCount?: number;
  audioFileCount?: number;
  lrcCount?: number;
  imageCount?: number;
  sidecarCount?: number;
  lrcCoverage?: number;
  totalBytes?: number;
  uploadSpeed?: number;
  freeUploadSlots?: boolean;
  queueLength?: number;
  score?: number;
  reason?: string;
  flags?: string[];
  files?: unknown[];
  raw?: unknown;
  ttlMinutes: number;
}

export function createCandidate(params: CreateCandidateParams): CandidateRecord {
  const db = getDb();
  const id = `cand_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60 * 1000);

  const record: CandidateRecord = {
    id,
    search_id: params.searchId,
    peer: params.peer,
    remote_directory: params.remoteDirectory,
    display_release: params.displayRelease ?? null,
    format: params.format ?? null,
    track_count: params.trackCount ?? null,
    audio_file_count: params.audioFileCount ?? null,
    lrc_count: params.lrcCount ?? null,
    image_count: params.imageCount ?? null,
    sidecar_count: params.sidecarCount ?? null,
    lrc_coverage: params.lrcCoverage ?? null,
    total_bytes: params.totalBytes ?? null,
    upload_speed: params.uploadSpeed ?? null,
    free_upload_slots: params.freeUploadSlots ? 1 : 0,
    queue_length: params.queueLength ?? null,
    score: params.score ?? null,
    reason: params.reason ?? null,
    flags_json: params.flags ? JSON.stringify(params.flags) : null,
    files_json: params.files ? JSON.stringify(params.files) : null,
    raw_json: params.raw ? JSON.stringify(params.raw) : null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  db.query(`
    INSERT INTO candidates (
      id, search_id, peer, remote_directory, display_release, format,
      track_count, audio_file_count, lrc_count, image_count, sidecar_count,
      lrc_coverage, total_bytes, upload_speed, free_upload_slots, queue_length,
      score, reason, flags_json, files_json, raw_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.search_id,
    record.peer,
    record.remote_directory,
    record.display_release,
    record.format,
    record.track_count,
    record.audio_file_count,
    record.lrc_count,
    record.image_count,
    record.sidecar_count,
    record.lrc_coverage,
    record.total_bytes,
    record.upload_speed,
    record.free_upload_slots,
    record.queue_length,
    record.score,
    record.reason,
    record.flags_json,
    record.files_json,
    record.raw_json,
    record.created_at,
    record.expires_at
  );

  return record;
}

/**
 * Upsert a candidate by (search_id, peer, remote_directory).
 * Keeps stable IDs across refreshes; updates stats/score/files.
 */
export function upsertCandidate(params: CreateCandidateParams): CandidateRecord {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60 * 1000);

  const existing = db
    .query<CandidateRecord, [string, string, string]>(
      "SELECT * FROM candidates WHERE search_id = ? AND peer = ? AND remote_directory = ?"
    )
    .get(params.searchId, params.peer, params.remoteDirectory);

  if (existing) {
    db.query(`
      UPDATE candidates SET
        display_release = ?, format = ?,
        track_count = ?, audio_file_count = ?,
        lrc_count = ?, image_count = ?, sidecar_count = ?,
        lrc_coverage = ?, total_bytes = ?,
        upload_speed = ?, free_upload_slots = ?, queue_length = ?,
        score = ?, reason = ?,
        flags_json = ?, files_json = ?, raw_json = ?,
        expires_at = ?
      WHERE id = ?
    `).run(
      params.displayRelease ?? existing.display_release,
      params.format ?? existing.format,
      params.trackCount ?? existing.track_count,
      params.audioFileCount ?? existing.audio_file_count,
      params.lrcCount ?? existing.lrc_count,
      params.imageCount ?? existing.image_count,
      params.sidecarCount ?? existing.sidecar_count,
      params.lrcCoverage ?? existing.lrc_coverage,
      params.totalBytes ?? existing.total_bytes,
      params.uploadSpeed ?? existing.upload_speed,
      params.freeUploadSlots !== undefined ? (params.freeUploadSlots ? 1 : 0) : existing.free_upload_slots,
      params.queueLength ?? existing.queue_length,
      params.score ?? existing.score,
      params.reason ?? existing.reason,
      params.flags ? JSON.stringify(params.flags) : existing.flags_json,
      params.files ? JSON.stringify(params.files) : existing.files_json,
      params.raw ? JSON.stringify(params.raw) : existing.raw_json,
      expiresAt.toISOString(),
      existing.id
    );

    return { ...existing, ...pickDefined(params, existing), expires_at: expiresAt.toISOString() };
  }

  return createCandidate(params);
}

function pickDefined(params: CreateCandidateParams, existing: CandidateRecord): Partial<CandidateRecord> {
  return {
    display_release: params.displayRelease ?? existing.display_release,
    format: params.format ?? existing.format,
    track_count: params.trackCount ?? existing.track_count,
    audio_file_count: params.audioFileCount ?? existing.audio_file_count,
    lrc_count: params.lrcCount ?? existing.lrc_count,
    image_count: params.imageCount ?? existing.image_count,
    sidecar_count: params.sidecarCount ?? existing.sidecar_count,
    lrc_coverage: params.lrcCoverage ?? existing.lrc_coverage,
    total_bytes: params.totalBytes ?? existing.total_bytes,
    upload_speed: params.uploadSpeed ?? existing.upload_speed,
    free_upload_slots: params.freeUploadSlots !== undefined ? (params.freeUploadSlots ? 1 : 0) : existing.free_upload_slots,
    queue_length: params.queueLength ?? existing.queue_length,
    score: params.score ?? existing.score,
    reason: params.reason ?? existing.reason,
    flags_json: params.flags ? JSON.stringify(params.flags) : existing.flags_json,
    files_json: params.files ? JSON.stringify(params.files) : existing.files_json,
  };
}

export function getCandidate(id: string): CandidateRecord | null {
  const db = getDb();
  return (
    db
      .query<CandidateRecord, [string]>("SELECT * FROM candidates WHERE id = ?")
      .get(id) ?? null
  );
}

export function getCandidatesBySearch(searchId: string): CandidateRecord[] {
  const db = getDb();
  return db
    .query<CandidateRecord, [string]>(
      "SELECT * FROM candidates WHERE search_id = ? ORDER BY score DESC"
    )
    .all(searchId);
}

export function isCandidateExpired(candidate: CandidateRecord): boolean {
  return new Date(candidate.expires_at) < new Date();
}
