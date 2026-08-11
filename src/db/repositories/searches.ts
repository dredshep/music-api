import { getDb } from "../database";
import { ulid } from "ulid";

export interface SearchRecord {
  id: string;
  artist: string;
  title: string;
  release_type: string | null;
  raw_query: string | null;
  slskd_search_ids_json: string | null;
  created_at: string;
  expires_at: string;
}

export function createSearch(params: {
  artist: string;
  title: string;
  releaseType?: string;
  rawQuery?: string;
  slskdSearchIds?: string[];
  ttlMinutes: number;
}): SearchRecord {
  const db = getDb();
  const id = `search_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlMinutes * 60 * 1000);

  const record: SearchRecord = {
    id,
    artist: params.artist,
    title: params.title,
    release_type: params.releaseType ?? null,
    raw_query: params.rawQuery ?? null,
    slskd_search_ids_json: params.slskdSearchIds
      ? JSON.stringify(params.slskdSearchIds)
      : null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  db.query(`
    INSERT INTO searches (id, artist, title, release_type, raw_query, slskd_search_ids_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.artist,
    record.title,
    record.release_type,
    record.raw_query,
    record.slskd_search_ids_json,
    record.created_at,
    record.expires_at
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
