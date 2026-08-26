import { getDb } from "../database";
import { ulid } from "ulid";

export interface SearchVariantRecord {
  id: string;
  semantic_search_id: string;
  query: string;
  query_fingerprint: string;
  slskd_search_id: string;
  discovered: number;
  created_at: string;
  last_seen_at: string;
  missing_at: string | null;
}

export function upsertSearchVariant(params: {
  semanticSearchId: string;
  query: string;
  queryFingerprint: string;
  slskdSearchId: string;
  discovered?: boolean;
}): SearchVariantRecord {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .query<SearchVariantRecord, [string, string]>(
      "SELECT * FROM search_variants WHERE semantic_search_id = ? AND query_fingerprint = ?"
    )
    .get(params.semanticSearchId, params.queryFingerprint);

  if (existing) {
    db.query(`
      UPDATE search_variants SET
        slskd_search_id = ?,
        last_seen_at = ?,
        missing_at = NULL
      WHERE id = ?
    `).run(params.slskdSearchId, now, existing.id);

    return {
      ...existing,
      slskd_search_id: params.slskdSearchId,
      last_seen_at: now,
      missing_at: null,
    };
  }

  const id = `sv_${ulid()}`;
  const record: SearchVariantRecord = {
    id,
    semantic_search_id: params.semanticSearchId,
    query: params.query,
    query_fingerprint: params.queryFingerprint,
    slskd_search_id: params.slskdSearchId,
    discovered: params.discovered ? 1 : 0,
    created_at: now,
    last_seen_at: now,
    missing_at: null,
  };

  db.query(`
    INSERT INTO search_variants (
      id, semantic_search_id, query, query_fingerprint,
      slskd_search_id, discovered, created_at, last_seen_at, missing_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.semantic_search_id,
    record.query,
    record.query_fingerprint,
    record.slskd_search_id,
    record.discovered,
    record.created_at,
    record.last_seen_at,
    record.missing_at
  );

  return record;
}

export function getVariantsForSearch(semanticSearchId: string): SearchVariantRecord[] {
  const db = getDb();
  return db
    .query<SearchVariantRecord, [string]>(
      "SELECT * FROM search_variants WHERE semantic_search_id = ? AND missing_at IS NULL ORDER BY created_at"
    )
    .all(semanticSearchId);
}

export function markVariantMissing(id: string): void {
  const db = getDb();
  db.query("UPDATE search_variants SET missing_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function getVariantBySlskdId(slskdSearchId: string): SearchVariantRecord | null {
  const db = getDb();
  return (
    db
      .query<SearchVariantRecord, [string]>(
        "SELECT * FROM search_variants WHERE slskd_search_id = ?"
      )
      .get(slskdSearchId) ?? null
  );
}
