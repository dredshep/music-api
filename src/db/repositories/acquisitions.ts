import { ulid } from "ulid";
import { getDb } from "../database";

export type AcquisitionStatus = "acquiring" | "verifying" | "completed" | "failed";

export interface AcquisitionRecord {
  id: string;
  artist: string;
  title: string;
  release_type: string;
  search_id: string;
  status: AcquisitionStatus;
  current_job_id: string | null;
  attempted_candidate_ids_json: string;
  blocked_peers_json: string;
  source_attempts: number;
  max_source_attempts: number;
  verification_started_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AcquisitionAttemptRecord {
  id: string;
  acquisition_id: string;
  candidate_id: string;
  job_id: string;
  peer: string;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createAcquisition(params: {
  artist: string;
  title: string;
  releaseType: string;
  searchId: string;
  maxSourceAttempts: number;
}): AcquisitionRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const record: AcquisitionRecord = {
    id: `acq_${ulid()}`,
    artist: params.artist,
    title: params.title,
    release_type: params.releaseType,
    search_id: params.searchId,
    status: "acquiring",
    current_job_id: null,
    attempted_candidate_ids_json: "[]",
    blocked_peers_json: "[]",
    source_attempts: 0,
    max_source_attempts: params.maxSourceAttempts,
    verification_started_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };

  db.query(`
    INSERT INTO acquisitions (
      id, artist, title, release_type, search_id, status, current_job_id,
      attempted_candidate_ids_json, blocked_peers_json, source_attempts,
      max_source_attempts, verification_started_at, last_error,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.artist,
    record.title,
    record.release_type,
    record.search_id,
    record.status,
    record.current_job_id,
    record.attempted_candidate_ids_json,
    record.blocked_peers_json,
    record.source_attempts,
    record.max_source_attempts,
    record.verification_started_at,
    record.last_error,
    record.created_at,
    record.updated_at,
    record.completed_at
  );

  return record;
}

export function getAcquisition(id: string): AcquisitionRecord | null {
  return getDb()
    .query<AcquisitionRecord, [string]>("SELECT * FROM acquisitions WHERE id = ?")
    .get(id) ?? null;
}

export function findActiveAcquisition(params: {
  artist: string;
  title: string;
  releaseType: string;
}): AcquisitionRecord | null {
  return getDb().query<AcquisitionRecord, [string, string, string]>(`
    SELECT * FROM acquisitions
    WHERE lower(artist) = lower(?)
      AND lower(title) = lower(?)
      AND release_type = ?
      AND status IN ('acquiring', 'verifying')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(params.artist, params.title, params.releaseType) ?? null;
}

export function listActiveAcquisitions(limit = 100): AcquisitionRecord[] {
  return getDb().query<AcquisitionRecord, [number]>(`
    SELECT * FROM acquisitions
    WHERE status IN ('acquiring', 'verifying')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

export function getAcquisitionByJobId(jobId: string): AcquisitionRecord | null {
  return getDb().query<AcquisitionRecord, [string]>(`
    SELECT a.*
    FROM acquisitions a
    JOIN acquisition_attempts aa ON aa.acquisition_id = a.id
    WHERE aa.job_id = ?
    ORDER BY aa.created_at DESC
    LIMIT 1
  `).get(jobId) ?? null;
}

export function setCurrentAttempt(params: {
  acquisitionId: string;
  candidateId: string;
  jobId: string;
  peer: string;
}): AcquisitionRecord {
  const db = getDb();
  const acquisition = getAcquisition(params.acquisitionId);
  if (!acquisition) throw new Error(`Acquisition not found: ${params.acquisitionId}`);

  const attempted = parseStringArray(acquisition.attempted_candidate_ids_json);
  if (!attempted.includes(params.candidateId)) attempted.push(params.candidateId);

  const now = new Date().toISOString();
  db.query(`
    UPDATE acquisitions
    SET current_job_id = ?,
        attempted_candidate_ids_json = ?,
        source_attempts = source_attempts + 1,
        status = 'acquiring',
        verification_started_at = NULL,
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(params.jobId, JSON.stringify(attempted), now, params.acquisitionId);

  db.query(`
    INSERT INTO acquisition_attempts (
      id, acquisition_id, candidate_id, job_id, peer, status, error,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, NULL)
  `).run(
    `acqa_${ulid()}`,
    params.acquisitionId,
    params.candidateId,
    params.jobId,
    params.peer,
    now
  );

  return getAcquisition(params.acquisitionId)!;
}

export function finishAttempt(jobId: string, status: string, error?: string | null): void {
  getDb().query(`
    UPDATE acquisition_attempts
    SET status = ?, error = ?, completed_at = ?
    WHERE job_id = ? AND completed_at IS NULL
  `).run(status, error ?? null, new Date().toISOString(), jobId);
}

export function blockPeer(acquisitionId: string, peer: string): void {
  const acquisition = getAcquisition(acquisitionId);
  if (!acquisition) return;
  const peers = parseStringArray(acquisition.blocked_peers_json);
  if (!peers.some((x) => x.toLowerCase() === peer.toLowerCase())) peers.push(peer);
  getDb().query(
    "UPDATE acquisitions SET blocked_peers_json = ?, updated_at = ? WHERE id = ?"
  ).run(JSON.stringify(peers), new Date().toISOString(), acquisitionId);
}

export function updateAcquisitionStatus(
  id: string,
  status: AcquisitionStatus,
  params?: { error?: string | null; verificationStartedAt?: string | null }
): void {
  const now = new Date().toISOString();
  const completedAt = status === "completed" || status === "failed" ? now : null;
  getDb().query(`
    UPDATE acquisitions
    SET status = ?,
        last_error = ?,
        verification_started_at = COALESCE(?, verification_started_at),
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    status,
    params?.error ?? null,
    params?.verificationStartedAt ?? null,
    completedAt,
    now,
    id
  );
}

export function parseAttemptedCandidates(acquisition: AcquisitionRecord): string[] {
  return parseStringArray(acquisition.attempted_candidate_ids_json);
}

export function parseBlockedPeers(acquisition: AcquisitionRecord): string[] {
  return parseStringArray(acquisition.blocked_peers_json);
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
