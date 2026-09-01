import { getDb } from "../database";
import { ulid } from "ulid";
import type { NavidromeMatchStatus } from "../../domain/navidrome-matching";

// --- Types ---

export type GenerationStatus = "running" | "completed" | "partial" | "failed";
export type RecommendationType = "artist" | "release_group";
export type RecommendationSource = "lastfm_similar" | "listenbrainz_cf" | "musicbrainz_new_release";
export type RecommendationReason = "similar_to_recent" | "similar_to_favorite" | "collaborative" | "new_release" | "wildcard";
export type { NavidromeMatchStatus };
export type FeedbackValue = "love" | "interested" | "meh" | "dislike" | "already_know";
export type RecommendationStatus = "active" | "suppressed" | "dismissed";

export interface GenerationRecord {
  id: string;
  status: GenerationStatus;
  started_at: string;
  completed_at: string | null;
  seed_count: number;
  observation_count: number;
  canonical_candidate_count: number;
  eligible_candidate_count: number;
  selected_count: number;
  error_count: number;
  config_json: string | null;
  stats_json: string | null;
  error_json: string | null;
}

export interface CandidateRecord {
  id: string;
  generation_id: string;
  type: RecommendationType;
  artist_mbid: string | null;
  release_group_mbid: string | null;
  artist_name: string;
  release_title: string | null;
  first_release_date: string | null;
  navidrome_match_status: NavidromeMatchStatus | "unchecked";
  navidrome_match_confidence: number;
  score: number;
  score_breakdown_json: string | null;
  primary_reason: RecommendationReason | null;
  selected: number;
  created_at: string;
}

export interface EvidenceRecord {
  id: string;
  candidate_id: string;
  source: RecommendationSource;
  reason: RecommendationReason;
  source_score: number | null;
  seed_artist_mbid: string | null;
  seed_artist_name: string | null;
  seed_affinity: number | null;
  recording_mbid: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface RecommendationRecord {
  id: string;
  type: RecommendationType;
  artist_mbid: string | null;
  release_group_mbid: string | null;
  artist_name: string;
  release_title: string | null;
  first_release_date: string | null;
  score: number;
  score_breakdown_json: string | null;
  primary_reason: RecommendationReason | null;
  navidrome_match_status: NavidromeMatchStatus | "unchecked";
  first_seen_at: string;
  last_seen_at: string;
  last_recommended_at: string | null;
  times_seen: number;
  times_recommended: number;
  status: RecommendationStatus;
  feedback: FeedbackValue | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackRecord {
  id: string;
  recommendation_id: string;
  feedback: FeedbackValue;
  created_at: string;
}

// --- Generations ---

export function createGeneration(configJson?: string): GenerationRecord {
  const db = getDb();
  const id = `gen_${ulid()}`;
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO recommendation_generations (id, status, started_at, config_json)
    VALUES (?, 'running', ?, ?)
  `).run(id, now, configJson ?? null);

  return getGeneration(id)!;
}

export function getGeneration(id: string): GenerationRecord | null {
  const db = getDb();
  return db.query<GenerationRecord, [string]>(
    "SELECT * FROM recommendation_generations WHERE id = ?"
  ).get(id) ?? null;
}

export function updateGeneration(
  id: string,
  updates: Partial<Pick<GenerationRecord,
    "status" | "completed_at" | "seed_count" | "observation_count" |
    "canonical_candidate_count" | "eligible_candidate_count" |
    "selected_count" | "error_count" | "stats_json" | "error_json"
  >>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }

  if (sets.length === 0) return;
  values.push(id);

  db.query(`UPDATE recommendation_generations SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function listGenerations(params?: {
  status?: GenerationStatus;
  limit?: number;
}): GenerationRecord[] {
  const db = getDb();
  const limit = params?.limit ?? 20;

  if (params?.status) {
    return db.query<GenerationRecord, [string, number]>(
      "SELECT * FROM recommendation_generations WHERE status = ? ORDER BY started_at DESC LIMIT ?"
    ).all(params.status, limit);
  }

  return db.query<GenerationRecord, [number]>(
    "SELECT * FROM recommendation_generations ORDER BY started_at DESC LIMIT ?"
  ).all(limit);
}

// --- Candidates ---

export function createCandidate(params: {
  generationId: string;
  type: RecommendationType;
  artistMbid: string | null;
  releaseGroupMbid: string | null;
  artistName: string;
  releaseTitle: string | null;
  firstReleaseDate: string | null;
  navidromeMatchStatus: NavidromeMatchStatus | "unchecked";
  navidromeMatchConfidence: number;
  score: number;
  scoreBreakdown: Record<string, number> | null;
  primaryReason: RecommendationReason | null;
  selected: boolean;
}): string {
  const db = getDb();
  const id = `cand_${ulid()}`;
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO recommendation_candidates
    (id, generation_id, type, artist_mbid, release_group_mbid, artist_name, release_title,
     first_release_date, navidrome_match_status, navidrome_match_confidence, score, score_breakdown_json,
     primary_reason, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.generationId, params.type, params.artistMbid, params.releaseGroupMbid,
    params.artistName, params.releaseTitle, params.firstReleaseDate,
    params.navidromeMatchStatus, params.navidromeMatchConfidence, params.score,
    params.scoreBreakdown ? JSON.stringify(params.scoreBreakdown) : null,
    params.primaryReason, params.selected ? 1 : 0, now
  );

  return id;
}

export function getCandidatesByGeneration(generationId: string): CandidateRecord[] {
  const db = getDb();
  return db.query<CandidateRecord, [string]>(
    "SELECT * FROM recommendation_candidates WHERE generation_id = ? ORDER BY score DESC"
  ).all(generationId);
}

// --- Evidence ---

export function createEvidence(params: {
  candidateId: string;
  source: RecommendationSource;
  reason: RecommendationReason;
  sourceScore: number | null;
  seedArtistMbid: string | null;
  seedArtistName: string | null;
  seedAffinity: number | null;
  recordingMbid: string | null;
  metadata: Record<string, unknown> | null;
}): string {
  const db = getDb();
  const id = `ev_${ulid()}`;
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO recommendation_evidence
    (id, candidate_id, source, reason, source_score, seed_artist_mbid, seed_artist_name,
     seed_affinity, recording_mbid, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.candidateId, params.source, params.reason, params.sourceScore,
    params.seedArtistMbid, params.seedArtistName, params.seedAffinity,
    params.recordingMbid, params.metadata ? JSON.stringify(params.metadata) : null, now
  );

  return id;
}

export function getEvidenceForCandidate(candidateId: string): EvidenceRecord[] {
  const db = getDb();
  return db.query<EvidenceRecord, [string]>(
    "SELECT * FROM recommendation_evidence WHERE candidate_id = ? ORDER BY source_score DESC"
  ).all(candidateId);
}

// --- Recommendations (persistent) ---

export function upsertRecommendation(params: {
  type: RecommendationType;
  artistMbid: string | null;
  releaseGroupMbid: string | null;
  artistName: string;
  releaseTitle: string | null;
  firstReleaseDate: string | null;
  score: number;
  scoreBreakdown: Record<string, number> | null;
  primaryReason: RecommendationReason | null;
  navidromeMatchStatus: NavidromeMatchStatus | "unchecked";
}): string {
  const db = getDb();
  const now = new Date().toISOString();

  const uniqueKey = params.type === "artist" ? params.artistMbid : params.releaseGroupMbid;
  if (!uniqueKey) {
    const id = `rec_${ulid()}`;
    db.query(`
      INSERT INTO recommendations
      (id, type, artist_mbid, release_group_mbid, artist_name, release_title,
       first_release_date, score, score_breakdown_json, primary_reason, navidrome_match_status,
       first_seen_at, last_seen_at, last_recommended_at, times_seen, times_recommended,
       status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active', ?, ?)
    `).run(
      id, params.type, params.artistMbid, params.releaseGroupMbid,
      params.artistName, params.releaseTitle, params.firstReleaseDate,
      params.score, params.scoreBreakdown ? JSON.stringify(params.scoreBreakdown) : null,
      params.primaryReason, params.navidromeMatchStatus, now, now, now, now, now
    );
    return id;
  }

  const existing = params.type === "artist"
    ? db.query<RecommendationRecord, [string]>(
        "SELECT * FROM recommendations WHERE type = 'artist' AND artist_mbid = ?"
      ).get(uniqueKey)
    : db.query<RecommendationRecord, [string]>(
        "SELECT * FROM recommendations WHERE type = 'release_group' AND release_group_mbid = ?"
      ).get(uniqueKey);

  if (existing) {
    db.query(`
      UPDATE recommendations SET
        score = ?, score_breakdown_json = ?, primary_reason = ?,
        navidrome_match_status = ?, last_seen_at = ?, last_recommended_at = ?,
        times_seen = times_seen + 1, times_recommended = times_recommended + 1,
        artist_name = ?, release_title = COALESCE(?, release_title),
        first_release_date = COALESCE(?, first_release_date),
        status = CASE WHEN feedback IN ('dislike', 'already_know') THEN status ELSE 'active' END,
        updated_at = ?
      WHERE id = ?
    `).run(
      params.score, params.scoreBreakdown ? JSON.stringify(params.scoreBreakdown) : null,
      params.primaryReason, params.navidromeMatchStatus, now, now,
      params.artistName, params.releaseTitle, params.firstReleaseDate, now,
      existing.id
    );
    return existing.id;
  }

  const id = `rec_${ulid()}`;
  db.query(`
    INSERT INTO recommendations
    (id, type, artist_mbid, release_group_mbid, artist_name, release_title,
     first_release_date, score, score_breakdown_json, primary_reason, navidrome_match_status,
     first_seen_at, last_seen_at, last_recommended_at, times_seen, times_recommended,
     status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active', ?, ?)
  `).run(
    id, params.type, params.artistMbid, params.releaseGroupMbid,
    params.artistName, params.releaseTitle, params.firstReleaseDate,
    params.score, params.scoreBreakdown ? JSON.stringify(params.scoreBreakdown) : null,
    params.primaryReason, params.navidromeMatchStatus, now, now, now, now, now
  );
  return id;
}

export function getRecommendation(id: string): RecommendationRecord | null {
  const db = getDb();
  return db.query<RecommendationRecord, [string]>(
    "SELECT * FROM recommendations WHERE id = ?"
  ).get(id) ?? null;
}

export function listRecommendations(params?: {
  type?: RecommendationType;
  reason?: RecommendationReason;
  minScore?: number;
  includeMatched?: boolean;
  includePossibleMatch?: boolean;
  status?: RecommendationStatus;
  limit?: number;
}): RecommendationRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const limit = params?.limit ?? 50;

  if (params?.type) {
    conditions.push("type = ?");
    values.push(params.type);
  }

  if (params?.reason) {
    conditions.push("primary_reason = ?");
    values.push(params.reason);
  }

  if (params?.minScore !== undefined) {
    conditions.push("score >= ?");
    values.push(params.minScore);
  }

  if (!params?.includeMatched) {
    conditions.push("navidrome_match_status != 'matched'");
  }

  if (!params?.includePossibleMatch) {
    conditions.push("navidrome_match_status != 'possible_match'");
  }

  if (params?.status) {
    conditions.push("status = ?");
    values.push(params.status);
  } else {
    conditions.push("status = 'active'");
  }

  conditions.push("(feedback IS NULL OR feedback NOT IN ('dislike', 'already_know'))");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit);

  return db.query<RecommendationRecord, (string | number)[]>(
    `SELECT * FROM recommendations ${where} ORDER BY score DESC LIMIT ?`
  ).all(...values);
}

export function getRecommendationByMbid(
  type: RecommendationType,
  mbid: string
): RecommendationRecord | null {
  const db = getDb();
  if (type === "artist") {
    return db.query<RecommendationRecord, [string]>(
      "SELECT * FROM recommendations WHERE type = 'artist' AND artist_mbid = ?"
    ).get(mbid) ?? null;
  }
  return db.query<RecommendationRecord, [string]>(
    "SELECT * FROM recommendations WHERE type = 'release_group' AND release_group_mbid = ?"
  ).get(mbid) ?? null;
}

export function getRecentlyRecommendedMbids(
  cooldownDays: number
): Set<string> {
  const db = getDb();
  const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.query<{ artist_mbid: string | null; release_group_mbid: string | null }, [string]>(
    "SELECT artist_mbid, release_group_mbid FROM recommendations WHERE last_recommended_at >= ?"
  ).all(since);

  const set = new Set<string>();
  for (const row of rows) {
    if (row.artist_mbid) set.add(row.artist_mbid);
    if (row.release_group_mbid) set.add(row.release_group_mbid);
  }
  return set;
}

// --- Feedback ---

export function addFeedback(
  recommendationId: string,
  feedback: FeedbackValue
): void {
  const db = getDb();
  const id = `fb_${ulid()}`;
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO recommendation_feedback (id, recommendation_id, feedback, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, recommendationId, feedback, now);

  db.query(`
    UPDATE recommendations SET feedback = ?, updated_at = ?,
      status = CASE
        WHEN ? IN ('dislike', 'already_know') THEN 'suppressed'
        ELSE status
      END
    WHERE id = ?
  `).run(feedback, now, feedback, recommendationId);
}

export function getFeedbackForRecommendation(recommendationId: string): FeedbackRecord[] {
  const db = getDb();
  return db.query<FeedbackRecord, [string]>(
    "SELECT * FROM recommendation_feedback WHERE recommendation_id = ? ORDER BY created_at DESC"
  ).all(recommendationId);
}
