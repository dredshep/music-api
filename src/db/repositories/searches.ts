import { getDb } from "../database";
import { ulid } from "ulid";
import type { SearchCollectionDiagnostics } from "../../services/slskd";
import {
  computeSemanticFingerprint,
  normalizeForComparison,
} from "../../domain/normalization";

export type SearchState = "collecting" | "settled" | "expired";

export interface SearchRecord {
  id: string;
  artist: string;
  title: string;
  release_type: string | null;
  raw_query: string | null;
  slskd_search_ids_json: string | null;
  state: string;
  search_options_json: string | null;
  preferred_formats_json: string | null;
  prefer_lrc: number;
  max_candidates: number;
  lifecycle_json: string | null;
  diagnostics_json: string | null;
  candidate_count: number;
  last_refreshed_at: string | null;
  settled_at: string | null;
  created_at: string;
  expires_at: string;
  fingerprint: string | null;
  normalized_artist: string | null;
  normalized_title: string | null;
  last_used_at: string | null;
}

export interface SearchLifecycle {
  state: SearchState;
  age_ms: number;
  collection_ms: number;
  settled: boolean;
  last_new_result_at: string | null;
  recommended_refresh_after_ms: number | null;
}

export interface CreateSearchParams {
  artist: string;
  title: string;
  releaseType?: string;
  rawQuery?: string;
  slskdSearchIds?: string[];
  ttlMinutes: number;
  preferredFormats?: string[];
  preferLrc?: boolean;
  maxCandidates?: number;
}

export function findSearchByFingerprint(fingerprint: string): SearchRecord | null {
  const db = getDb();
  return (
    db
      .query<SearchRecord, [string]>(
        "SELECT * FROM searches WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(fingerprint) ?? null
  );
}

export function touchSearchUsage(id: string): void {
  const db = getDb();
  db.query("UPDATE searches SET last_used_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function createSearch(params: CreateSearchParams): SearchRecord {
  const db = getDb();
  const id = `search_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60 * 1000);

  const releaseType = params.releaseType ?? "album";
  const fingerprint = computeSemanticFingerprint(params.artist, params.title, releaseType);
  const normalizedArtist = normalizeForComparison(params.artist);
  const normalizedTitle = normalizeForComparison(params.title);

  const record: SearchRecord = {
    id,
    artist: params.artist,
    title: params.title,
    release_type: releaseType,
    raw_query: params.rawQuery ?? null,
    slskd_search_ids_json: params.slskdSearchIds
      ? JSON.stringify(params.slskdSearchIds)
      : null,
    state: "collecting",
    search_options_json: JSON.stringify({
      preferred_formats: params.preferredFormats ?? ["FLAC", "MP3"],
      prefer_lrc: params.preferLrc ?? true,
      max_candidates: params.maxCandidates ?? 10,
      release_type: releaseType,
    }),
    preferred_formats_json: params.preferredFormats
      ? JSON.stringify(params.preferredFormats)
      : null,
    prefer_lrc: params.preferLrc !== false ? 1 : 0,
    max_candidates: params.maxCandidates ?? 10,
    lifecycle_json: null,
    diagnostics_json: null,
    candidate_count: 0,
    last_refreshed_at: null,
    settled_at: null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    fingerprint,
    normalized_artist: normalizedArtist,
    normalized_title: normalizedTitle,
    last_used_at: now.toISOString(),
  };

  db.query(`
    INSERT INTO searches (
      id, artist, title, release_type, raw_query, slskd_search_ids_json,
      state, search_options_json, preferred_formats_json, prefer_lrc,
      max_candidates, lifecycle_json, diagnostics_json, candidate_count,
      last_refreshed_at, settled_at, created_at, expires_at,
      fingerprint, normalized_artist, normalized_title, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.artist,
    record.title,
    record.release_type,
    record.raw_query,
    record.slskd_search_ids_json,
    record.state,
    record.search_options_json,
    record.preferred_formats_json,
    record.prefer_lrc,
    record.max_candidates,
    record.lifecycle_json,
    record.diagnostics_json,
    record.candidate_count,
    record.last_refreshed_at,
    record.settled_at,
    record.created_at,
    record.expires_at,
    record.fingerprint,
    record.normalized_artist,
    record.normalized_title,
    record.last_used_at
  );

  return record;
}

export function getSearch(id: string): SearchRecord | null {
  const db = getDb();
  return (
    db
      .query<SearchRecord, [string]>("SELECT * FROM searches WHERE id = ?")
      .get(id) ?? null
  );
}

export function isSearchExpired(search: SearchRecord): boolean {
  return new Date(search.expires_at) < new Date();
}

export function updateSearchLifecycle(
  id: string,
  params: {
    state?: SearchState;
    diagnostics?: SearchCollectionDiagnostics;
    candidateCount?: number;
    lifecycle?: SearchLifecycle;
  }
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const sets: string[] = [];
  const args: Array<string | number | null> = [];

  if (params.state !== undefined) {
    sets.push("state = ?");
    args.push(params.state);
    if (params.state === "settled") {
      sets.push("settled_at = ?");
      args.push(now);
    }
  }

  if (params.diagnostics !== undefined) {
    sets.push("diagnostics_json = ?");
    args.push(JSON.stringify(params.diagnostics));
  }

  if (params.candidateCount !== undefined) {
    sets.push("candidate_count = ?");
    args.push(params.candidateCount);
  }

  if (params.lifecycle !== undefined) {
    sets.push("lifecycle_json = ?");
    args.push(JSON.stringify(params.lifecycle));
  }

  sets.push("last_refreshed_at = ?");
  args.push(now);

  if (sets.length === 0) return;

  args.push(id);
  db.query(`UPDATE searches SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function buildSearchLifecycle(
  search: SearchRecord,
  diagnostics: SearchCollectionDiagnostics
): SearchLifecycle {
  const ageMs = Date.now() - new Date(search.created_at).getTime();
  const settled = diagnostics.settled;

  let recommendedRefresh: number | null = null;
  if (!settled && diagnostics.audioDirectories === 0) {
    recommendedRefresh = Math.min(5000, Math.max(2000, diagnostics.collectionMs));
  } else if (!settled) {
    recommendedRefresh = 5000;
  }

  return {
    state: settled ? "settled" : "collecting",
    age_ms: ageMs,
    collection_ms: diagnostics.collectionMs,
    settled,
    last_new_result_at: search.last_refreshed_at,
    recommended_refresh_after_ms: recommendedRefresh,
  };
}
