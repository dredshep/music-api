import { getDb } from "../database";
import { ulid } from "ulid";

export interface LyricAcquisitionRecord {
  id: string;
  navidrome_song_id: string | null;
  artist: string;
  title: string;
  album: string | null;
  lrclib_id: number | null;
  match_type: string;
  match_confidence: number;
  duration_delta_s: number | null;
  has_synced: number;
  has_plain: number;
  synced_lyrics: string | null;
  plain_lyrics: string | null;
  status: string;
  target_path: string | null;
  staged_path: string | null;
  deployed_at: string | null;
  created_at: string;
}

export function createLyricAcquisition(params: {
  navidromeSongId?: string;
  artist: string;
  title: string;
  album?: string;
  lrclibId?: number;
  matchType: string;
  matchConfidence: number;
  durationDeltaS?: number;
  hasSynced: boolean;
  hasPlain: boolean;
  syncedLyrics?: string;
  plainLyrics?: string;
  targetPath?: string;
  stagedPath?: string;
  status?: string;
}): LyricAcquisitionRecord {
  const db = getDb();
  const id = `lrc_${ulid()}`;
  const now = new Date().toISOString();

  const record: LyricAcquisitionRecord = {
    id,
    navidrome_song_id: params.navidromeSongId ?? null,
    artist: params.artist,
    title: params.title,
    album: params.album ?? null,
    lrclib_id: params.lrclibId ?? null,
    match_type: params.matchType,
    match_confidence: params.matchConfidence,
    duration_delta_s: params.durationDeltaS ?? null,
    has_synced: params.hasSynced ? 1 : 0,
    has_plain: params.hasPlain ? 1 : 0,
    synced_lyrics: params.syncedLyrics ?? null,
    plain_lyrics: params.plainLyrics ?? null,
    status: params.status ?? "staged",
    target_path: params.targetPath ?? null,
    staged_path: params.stagedPath ?? null,
    deployed_at: null,
    created_at: now,
  };

  db.query(`
    INSERT INTO lyric_acquisitions (
      id, navidrome_song_id, artist, title, album,
      lrclib_id, match_type, match_confidence, duration_delta_s,
      has_synced, has_plain, synced_lyrics, plain_lyrics,
      status, target_path, staged_path, deployed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.navidrome_song_id,
    record.artist,
    record.title,
    record.album,
    record.lrclib_id,
    record.match_type,
    record.match_confidence,
    record.duration_delta_s,
    record.has_synced,
    record.has_plain,
    record.synced_lyrics,
    record.plain_lyrics,
    record.status,
    record.target_path,
    record.staged_path,
    record.deployed_at,
    record.created_at
  );

  return record;
}

export function getLyricAcquisition(id: string): LyricAcquisitionRecord | null {
  const db = getDb();
  return db
    .query<LyricAcquisitionRecord, [string]>(
      "SELECT * FROM lyric_acquisitions WHERE id = ?"
    )
    .get(id) ?? null;
}

export function getLyricAcquisitionBySong(navidromeSongId: string): LyricAcquisitionRecord | null {
  const db = getDb();
  return db
    .query<LyricAcquisitionRecord, [string]>(
      "SELECT * FROM lyric_acquisitions WHERE navidrome_song_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(navidromeSongId) ?? null;
}

export function getLyricAcquisitionByLrclibId(lrclibId: number): LyricAcquisitionRecord | null {
  const db = getDb();
  return db
    .query<LyricAcquisitionRecord, [number]>(
      "SELECT * FROM lyric_acquisitions WHERE lrclib_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(lrclibId) ?? null;
}

export function updateLyricAcquisitionStatus(
  id: string,
  status: string,
  stagedPath?: string,
  deployedAt?: string
): void {
  const db = getDb();
  if (stagedPath) {
    db.query(
      "UPDATE lyric_acquisitions SET status = ?, staged_path = ?, deployed_at = ? WHERE id = ?"
    ).run(status, stagedPath, deployedAt ?? null, id);
  } else {
    db.query(
      "UPDATE lyric_acquisitions SET status = ?, deployed_at = ? WHERE id = ?"
    ).run(status, deployedAt ?? null, id);
  }
}

export function listLyricAcquisitions(params: {
  status?: string;
  limit?: number;
}): LyricAcquisitionRecord[] {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  if (params.status) {
    return db
      .query<LyricAcquisitionRecord, [string, number]>(
        "SELECT * FROM lyric_acquisitions WHERE status = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(params.status, limit);
  }

  return db
    .query<LyricAcquisitionRecord, [number]>(
      "SELECT * FROM lyric_acquisitions ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit);
}
