import { createHash } from "node:crypto";
import { getConfig } from "../config";
import { getDb } from "../db/database";
import { extractEditionInfo, normalizeForComparison } from "../domain/normalization";
import { matchLibraryTrack } from "../domain/track-ownership";
import * as navidromePlayer from "./navidrome-player";
import type { LibrarySong } from "./navidrome";

export type LibrarySnapshot = {
  version: string;
  songs: LibrarySong[];
  songCount: number;
  builtAt: string;
  expiresAt: string;
  stale: boolean;
  lastError: string | null;
};

type SnapshotRow = {
  version: string;
  songs_json: string;
  song_count: number;
  built_at: string;
  expires_at: string;
  last_error: string | null;
};

function mapPlayerSong(song: navidromePlayer.PlayerSong): LibrarySong {
  return {
    id: song.id,
    title: song.title,
    album: song.album,
    artist: song.artist,
    albumId: song.albumId,
    artistId: song.artistId,
    track: song.track,
    year: song.year,
    duration: song.duration,
    path: song.path,
    suffix: song.suffix,
  };
}

function readRow(): LibrarySnapshot | null {
  const row = getDb().query<SnapshotRow, []>(`
    SELECT version, songs_json, song_count, built_at, expires_at, last_error
    FROM library_snapshots WHERE singleton = 1
  `).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.songs_json) as LibrarySong[];
    if (!Array.isArray(parsed)) return null;
    return {
      version: row.version,
      songs: parsed,
      songCount: row.song_count,
      builtAt: row.built_at,
      expiresAt: row.expires_at,
      stale: Date.parse(row.expires_at) <= Date.now(),
      lastError: row.last_error,
    };
  } catch {
    return null;
  }
}

export function getLibrarySnapshot(): LibrarySnapshot | null {
  return readRow();
}

async function fetchWholeLibrary(): Promise<LibrarySong[]> {
  const songs: LibrarySong[] = [];
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const page = await navidromePlayer.listSongs({ limit: pageSize, offset });
    songs.push(...page.songs.map(mapPlayerSong));
    if (!page.has_more || page.songs.length === 0) break;
    offset += page.songs.length;
  }
  return songs;
}

let rebuildInFlight: Promise<LibrarySnapshot> | null = null;

export async function rebuildLibrarySnapshot(): Promise<LibrarySnapshot> {
  if (rebuildInFlight) return rebuildInFlight;
  rebuildInFlight = (async () => {
    const songs = await fetchWholeLibrary();
    const builtAt = new Date().toISOString();
    const digest = createHash("sha256").update(JSON.stringify(songs)).digest("hex").slice(0, 24);
    const version = `${builtAt}:${digest}`;
    const ttlHours = Math.max(1, getConfig().LIBRARY_SNAPSHOT_TTL_HOURS);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60_000).toISOString();
    const db = getDb();
    db.exec("BEGIN");
    try {
      db.query(`
        INSERT INTO library_snapshots
          (singleton, version, songs_json, song_count, built_at, expires_at, last_error)
        VALUES (1, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          version = excluded.version,
          songs_json = excluded.songs_json,
          song_count = excluded.song_count,
          built_at = excluded.built_at,
          expires_at = excluded.expires_at,
          last_error = NULL
      `).run(version, JSON.stringify(songs), songs.length, builtAt, expiresAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { version, songs, songCount: songs.length, builtAt, expiresAt, stale: false, lastError: null };
  })();
  try {
    return await rebuildInFlight;
  } finally {
    rebuildInFlight = null;
  }
}

function recordSnapshotError(error: string) {
  getDb().query("UPDATE library_snapshots SET last_error = ? WHERE singleton = 1").run(error);
}

export async function getOrBuildLibrarySnapshot(refresh = false): Promise<LibrarySnapshot> {
  const existing = readRow();
  if (existing && !refresh) return existing;
  try {
    return await rebuildLibrarySnapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (existing) {
      recordSnapshotError(message);
      return { ...existing, lastError: message };
    }
    throw error;
  }
}

type IndexedSong = LibrarySong & { titleKey: string; baseTitleKey: string; fuzzyKeys: string[] };

export class LibraryOwnershipIndex {
  private readonly exact = new Map<string, IndexedSong[]>();
  private readonly base = new Map<string, IndexedSong[]>();
  private readonly fuzzy = new Map<string, IndexedSong[]>();

  constructor(public readonly version: string, songs: LibrarySong[]) {
    for (const song of songs) {
      const titleKey = normalizeForComparison(song.title);
      const baseTitleKey = normalizeForComparison(extractEditionInfo(song.title).baseTitle);
      const tokens = normalizeForComparison(song.title).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
      const fuzzyKeys = [...new Set(tokens.filter((token) => token.length >= 2).map((token) => token.slice(0, 3)))];
      const indexed = { ...song, titleKey, baseTitleKey, fuzzyKeys };
      this.addBounded(this.exact, titleKey, indexed, 500);
      this.addBounded(this.base, baseTitleKey, indexed, 500);
      for (const key of fuzzyKeys) this.addBounded(this.fuzzy, key, indexed, 120);
    }
  }

  private addBounded(map: Map<string, IndexedSong[]>, key: string, value: IndexedSong, limit: number) {
    if (!key) return;
    const bucket = map.get(key) ?? [];
    if (bucket.length < limit) bucket.push(value);
    map.set(key, bucket);
  }

  candidates(query: { title: string; artist: string; album?: string; durationMs?: number }) {
    const candidates = new Map<string, IndexedSong>();
    const add = (song: IndexedSong) => {
      if (candidates.size < 500) candidates.set(song.id, song);
    };
    for (const song of this.exact.get(normalizeForComparison(query.title)) ?? []) add(song);
    for (const song of this.base.get(normalizeForComparison(extractEditionInfo(query.title).baseTitle)) ?? []) add(song);
    const tokens = normalizeForComparison(query.title).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      for (const song of this.fuzzy.get(token.slice(0, 3)) ?? []) add(song);
    }
    return [...candidates.values()];
  }

  lookup(query: { artist: string; title: string; album?: string; durationMs?: number }) {
    return matchLibraryTrack(query, this.candidates(query));
  }
}

let cachedIndex: LibraryOwnershipIndex | null = null;

export function getLibraryOwnershipIndex(snapshot: LibrarySnapshot) {
  if (!cachedIndex || cachedIndex.version !== snapshot.version) {
    cachedIndex = new LibraryOwnershipIndex(snapshot.version, snapshot.songs);
  }
  return cachedIndex;
}
