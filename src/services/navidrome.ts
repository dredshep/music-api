import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";
import type {
  SubsonicResponse,
  SubsonicArtist,
  SubsonicAlbum,
  SubsonicSong,
  SubsonicSearchResult,
} from "../types/upstream";

/** Subsonic returns a single object when count is 1; normalize to an array. */
function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function md5(input: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(input);
  return hasher.digest("hex");
}

function generateSalt(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let salt = "";
  for (let i = 0; i < 12; i++) {
    salt += chars[bytes[i]! % chars.length];
  }
  return salt;
}

function buildAuthParams(): URLSearchParams {
  const config = getConfig();
  const salt = generateSalt();
  const token = md5(config.NAVIDROME_PASSWORD + salt);

  return new URLSearchParams({
    u: config.NAVIDROME_USERNAME,
    t: token,
    s: salt,
    v: config.NAVIDROME_API_VERSION,
    c: config.NAVIDROME_CLIENT_NAME,
    f: "json",
  });
}

async function subsonicFetch<T>(
  endpoint: string,
  extraParams?: Record<string, string>
): Promise<T> {
  const config = getConfig();
  const params = buildAuthParams();

  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      params.set(key, value);
    }
  }

  const url = `${config.NAVIDROME_URL}/rest/${endpoint}?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new AppError(
        "NAVIDROME_UNAVAILABLE",
        `Navidrome returned ${res.status}`,
        502,
        true
      );
    }

    const data = (await res.json()) as SubsonicResponse<T>;
    const inner = data["subsonic-response"];

    if (inner.status === "failed" && inner.error) {
      throw new AppError(
        "NAVIDROME_UNAVAILABLE",
        `Subsonic error ${inner.error.code}: ${inner.error.message}`,
        502,
        true
      );
    }

    return inner as unknown as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Navidrome connection failed";
    throw new AppError("NAVIDROME_UNAVAILABLE", message, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function ping(): Promise<boolean> {
  try {
    await subsonicFetch("ping");
    return true;
  } catch {
    return false;
  }
}

export interface LibraryArtist {
  id: string;
  name: string;
  albumCount: number;
}

export interface LibraryAlbum {
  id: string;
  artist: string;
  artistId: string;
  title: string;
  year?: number;
  songCount: number;
  duration: number;
  genre?: string;
  playCount?: number;
  played?: string;
}

export interface LibrarySong {
  id: string;
  title: string;
  album: string;
  artist: string;
  albumId: string;
  artistId: string;
  track?: number;
  year?: number;
  duration: number;
}

export interface LibraryArtistPlayStats {
  id: string;
  name: string;
  playCount: number;
  albumCountWithPlays: number;
}

export async function search3(
  query: string,
  params?: { artistCount?: number; albumCount?: number; songCount?: number }
): Promise<{ artists: LibraryArtist[]; albums: LibraryAlbum[]; songs: LibrarySong[] }> {
  const result = await subsonicFetch<{ searchResult3: SubsonicSearchResult }>(
    "search3",
    {
      query,
      artistCount: String(params?.artistCount ?? 20),
      albumCount: String(params?.albumCount ?? 20),
      songCount: String(params?.songCount ?? 0),
    }
  );

  const sr = result.searchResult3 ?? {};

  return {
    artists: asArray(sr.artist).map(mapArtist),
    albums: asArray(sr.album).map(mapAlbum),
    songs: asArray(sr.song).map(mapSong),
  };
}

export async function getArtists(): Promise<LibraryArtist[]> {
  const result = await subsonicFetch<{
    artists: { index: { artist: SubsonicArtist[] }[] };
  }>("getArtists");

  const artists: LibraryArtist[] = [];
  for (const idx of asArray(result.artists?.index)) {
    for (const a of asArray(idx.artist)) {
      artists.push(mapArtist(a));
    }
  }
  return artists;
}

export async function getArtist(
  id: string
): Promise<{ artist: LibraryArtist; albums: LibraryAlbum[] }> {
  const result = await subsonicFetch<{
    artist: SubsonicArtist & { album?: SubsonicAlbum[] };
  }>("getArtist", { id });

  return {
    artist: mapArtist(result.artist),
    albums: asArray(result.artist.album).map(mapAlbum),
  };
}

export async function getAlbum(
  id: string
): Promise<{ album: LibraryAlbum; songs: LibrarySong[] }> {
  const result = await subsonicFetch<{
    album: SubsonicAlbum & { song?: SubsonicSong[] };
  }>("getAlbum", { id });

  return {
    album: mapAlbum(result.album),
    songs: asArray(result.album.song).map(mapSong),
  };
}

export async function getSong(id: string): Promise<LibrarySong> {
  const result = await subsonicFetch<{ song: SubsonicSong }>("getSong", { id });
  return mapSong(result.song);
}

export async function getAlbumList2(params: {
  type: "frequent" | "recent" | "newest" | "highest" | "random" | "alphabeticalByName" | "alphabeticalByArtist";
  size?: number;
  offset?: number;
}): Promise<LibraryAlbum[]> {
  const result = await subsonicFetch<{
    albumList2: { album?: Array<SubsonicAlbum & { playCount?: number; played?: string }> };
  }>("getAlbumList2", {
    type: params.type,
    size: String(params.size ?? 500),
    offset: String(params.offset ?? 0),
  });

  return asArray(result.albumList2?.album).map((a) => ({
    ...mapAlbum(a),
    playCount: a.playCount,
    played: a.played,
  }));
}

/** Paginate getAlbumList2 until exhausted. Used for bulk catalog comparison. */
export async function getAllAlbums(): Promise<LibraryAlbum[]> {
  const pageSize = 500;
  const albums: LibraryAlbum[] = [];
  let offset = 0;

  for (;;) {
    const page = await getAlbumList2({
      type: "alphabeticalByArtist",
      size: pageSize,
      offset,
    });
    albums.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return albums;
}

/**
 * Aggregate album playCounts into per-artist listen totals.
 * Navidrome does not expose artist-level playCount via Subsonic;
 * this sums playCount across albums returned by getAlbumList2?type=frequent.
 */
export async function getTopArtistsByPlayCount(
  limit = 50
): Promise<{
  artists: LibraryArtistPlayStats[];
  albums_with_plays: number;
  method: string;
}> {
  const frequentAlbums = await getAlbumList2({
    type: "frequent",
    size: 500,
    offset: 0,
  });

  const byArtist = new Map<string, LibraryArtistPlayStats>();

  for (const album of frequentAlbums) {
    const plays = album.playCount ?? 0;
    if (plays <= 0) continue;

    const key = album.artistId || album.artist;
    const existing = byArtist.get(key);
    if (existing) {
      existing.playCount += plays;
      existing.albumCountWithPlays += 1;
    } else {
      byArtist.set(key, {
        id: album.artistId,
        name: album.artist,
        playCount: plays,
        albumCountWithPlays: 1,
      });
    }
  }

  const artists = Array.from(byArtist.values())
    .sort((a, b) => b.playCount - a.playCount || a.name.localeCompare(b.name))
    .slice(0, limit);

  return {
    artists,
    albums_with_plays: frequentAlbums.filter((a) => (a.playCount ?? 0) > 0).length,
    method: "sum_of_album_playCounts_from_getAlbumList2_frequent",
  };
}

export async function getScanStatus(): Promise<{
  scanning: boolean;
  count?: number;
}> {
  const result = await subsonicFetch<{
    scanStatus: { scanning: boolean; count?: number };
  }>("getScanStatus");
  return result.scanStatus;
}

export async function startScan(fullScan?: boolean): Promise<void> {
  log("info", "navidrome_scan_start", { full: !!fullScan });
  await subsonicFetch("startScan", fullScan ? { fullScan: "true" } : undefined);
}

function mapArtist(a: SubsonicArtist): LibraryArtist {
  return {
    id: a.id,
    name: a.name,
    albumCount: a.albumCount ?? 0,
  };
}

function mapAlbum(a: SubsonicAlbum & { playCount?: number; played?: string }): LibraryAlbum {
  return {
    id: a.id,
    artist: a.artist,
    artistId: a.artistId,
    title: a.name,
    year: a.year,
    songCount: a.songCount,
    duration: a.duration,
    genre: a.genre,
    playCount: a.playCount,
    played: a.played,
  };
}

function mapSong(s: SubsonicSong): LibrarySong {
  return {
    id: s.id,
    title: s.title,
    album: s.album,
    artist: s.artist,
    albumId: s.albumId,
    artistId: s.artistId,
    track: s.track,
    year: s.year,
    duration: s.duration,
  };
}
