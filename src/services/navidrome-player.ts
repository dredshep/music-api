import { getConfig } from "../config";
import { AppError } from "../middleware/errors";
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicResponse,
  SubsonicSearchResult,
  SubsonicSong,
} from "../types/upstream";

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function md5(input: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(input);
  return hasher.digest("hex");
}

function buildAuthParams(): URLSearchParams {
  const config = getConfig();
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let salt = "";
  for (let i = 0; i < bytes.length; i++) salt += alphabet[bytes[i]! % alphabet.length];
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

function endpointUrl(endpoint: string, params?: URLSearchParams | Record<string, string | undefined>): string {
  const config = getConfig();
  const query = buildAuthParams();
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) query.append(key, value);
  } else if (params) {
    for (const [key, value] of Object.entries(params)) if (value != null) query.set(key, value);
  }
  return `${config.NAVIDROME_URL.replace(/\/$/, "")}/rest/${endpoint}?${query.toString()}`;
}

async function jsonRequest<T>(endpoint: string, params?: Record<string, string | undefined>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpointUrl(endpoint, params), { signal: controller.signal });
    if (!response.ok) {
      throw new AppError("NAVIDROME_UNAVAILABLE", `Navidrome returned ${response.status}`, 502, true);
    }
    const body = (await response.json()) as SubsonicResponse<T>;
    const inner = body["subsonic-response"];
    if (inner.status === "failed" && inner.error) {
      throw new AppError(
        "NAVIDROME_UNAVAILABLE",
        `Subsonic error ${inner.error.code}: ${inner.error.message}`,
        502,
        true,
      );
    }
    return inner as unknown as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "NAVIDROME_UNAVAILABLE",
      error instanceof Error ? error.message : "Navidrome request failed",
      502,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function rawRequest(
  endpoint: string,
  params: Record<string, string | undefined>,
  headers?: Record<string, string>,
): Promise<Response> {
  try {
    const response = await fetch(endpointUrl(endpoint, params), {
      headers,
      redirect: "follow",
    });
    if (!response.ok && response.status !== 206) {
      const text = await response.text().catch(() => "");
      throw new AppError(
        "NAVIDROME_UNAVAILABLE",
        `Navidrome media request returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
        502,
        true,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "NAVIDROME_UNAVAILABLE",
      error instanceof Error ? error.message : "Navidrome media request failed",
      502,
      true,
    );
  }
}

export type PlayerReplayGain = {
  trackGain?: number;
  albumGain?: number;
  trackPeak?: number;
  albumPeak?: number;
  baseGain?: number;
  fallbackGain?: number;
};

export type PlayerSong = {
  id: string;
  title: string;
  album: string;
  artist: string;
  albumId: string;
  artistId: string;
  track?: number;
  year?: number;
  duration: number;
  size?: number;
  suffix?: string;
  bitRate?: number;
  path?: string;
  coverArt?: string;
  starred?: string;
  replayGain?: PlayerReplayGain;
};

export type PlayerAlbum = {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  songCount: number;
  duration: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  starred?: string;
  playCount?: number;
};

export type PlayerArtist = {
  id: string;
  name: string;
  albumCount: number;
  artistImageUrl?: string;
  starred?: string;
};

function mapSong(song: SubsonicSong & {
  coverArt?: string;
  starred?: string;
  replayGain?: PlayerReplayGain;
}): PlayerSong {
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
    size: song.size,
    suffix: song.suffix,
    bitRate: song.bitRate,
    path: song.path,
    coverArt: song.coverArt,
    starred: song.starred,
    replayGain: song.replayGain,
  };
}

function mapAlbum(album: SubsonicAlbum & {
  starred?: string;
  playCount?: number;
}): PlayerAlbum {
  return {
    id: album.id,
    title: album.name,
    artist: album.artist,
    artistId: album.artistId,
    songCount: album.songCount,
    duration: album.duration,
    year: album.year,
    genre: album.genre,
    coverArt: album.coverArt,
    starred: album.starred,
    playCount: album.playCount,
  };
}

function mapArtist(artist: SubsonicArtist & { starred?: string }): PlayerArtist {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount ?? 0,
    artistImageUrl: artist.artistImageUrl,
    starred: artist.starred,
  };
}

export async function getSong(id: string): Promise<PlayerSong> {
  const result = await jsonRequest<{ song: SubsonicSong & { coverArt?: string; starred?: string; replayGain?: PlayerReplayGain } }>(
    "getSong",
    { id },
  );
  return mapSong(result.song);
}

export async function getArtist(id: string): Promise<{ artist: PlayerArtist; albums: PlayerAlbum[] }> {
  const result = await jsonRequest<{
    artist: SubsonicArtist & { starred?: string; album?: Array<SubsonicAlbum & { starred?: string; playCount?: number }> };
  }>("getArtist", { id });
  return {
    artist: mapArtist(result.artist),
    albums: asArray(result.artist.album).map(mapAlbum),
  };
}

export async function getAlbum(id: string): Promise<{ album: PlayerAlbum; songs: PlayerSong[] }> {
  const result = await jsonRequest<{
    album: SubsonicAlbum & {
      starred?: string;
      playCount?: number;
      song?: Array<SubsonicSong & { coverArt?: string; starred?: string; replayGain?: PlayerReplayGain }>;
    };
  }>("getAlbum", { id });
  return { album: mapAlbum(result.album), songs: asArray(result.album.song).map(mapSong) };
}

export async function listSongs(params: { query?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const result = await jsonRequest<{ searchResult3: SubsonicSearchResult }>("search3", {
    query: params.query ?? "",
    artistCount: "0",
    albumCount: "0",
    songCount: String(limit),
    songOffset: String(offset),
  });
  const songs = asArray(result.searchResult3?.song).map((song) => mapSong(song as SubsonicSong));
  return { songs, offset, limit, has_more: songs.length === limit };
}

export async function listAlbums(params: {
  limit?: number;
  offset?: number;
  sort?: "alphabeticalByArtist" | "alphabeticalByName" | "recent" | "newest" | "frequent" | "random";
  genre?: string;
}) {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const type = params.genre ? "byGenre" : (params.sort ?? "alphabeticalByArtist");
  const result = await jsonRequest<{
    albumList2: { album?: Array<SubsonicAlbum & { starred?: string; playCount?: number }> };
  }>("getAlbumList2", {
    type,
    size: String(limit),
    offset: String(offset),
    genre: params.genre,
  });
  const albums = asArray(result.albumList2?.album).map(mapAlbum);
  return { albums, offset, limit, has_more: albums.length === limit };
}

export async function listStarredSongs(): Promise<PlayerSong[]> {
  const result = await jsonRequest<{
    starred2: { song?: Array<SubsonicSong & { coverArt?: string; starred?: string; replayGain?: PlayerReplayGain }> };
  }>("getStarred2");
  return asArray(result.starred2?.song).map(mapSong);
}

export async function listGenres() {
  const result = await jsonRequest<{
    genres: { genre?: Array<{ value: string; songCount?: number; albumCount?: number }> };
  }>("getGenres");
  return asArray(result.genres?.genre).map((genre) => ({
    name: genre.value,
    song_count: genre.songCount ?? 0,
    album_count: genre.albumCount ?? 0,
  }));
}

export async function getLyrics(id: string): Promise<unknown[]> {
  try {
    const result = await jsonRequest<{
      lyricsList?: { structuredLyrics?: unknown | unknown[] };
    }>("getLyricsBySongId", { id });
    return asArray(result.lyricsList?.structuredLyrics);
  } catch {
    return [];
  }
}

export async function streamSong(
  id: string,
  options: { range?: string; format?: "raw" | "mp3"; maxBitRate?: number } = {},
): Promise<Response> {
  return rawRequest(
    "stream",
    {
      id,
      format: options.format === "mp3" ? "mp3" : undefined,
      maxBitRate: options.format === "mp3" && options.maxBitRate ? String(options.maxBitRate) : undefined,
      estimateContentLength: "true",
    },
    options.range ? { Range: options.range } : undefined,
  );
}

export async function downloadSong(id: string, range?: string): Promise<Response> {
  return rawRequest("download", { id }, range ? { Range: range } : undefined);
}

export async function coverArt(id: string, size?: number): Promise<Response> {
  return rawRequest("getCoverArt", { id, size: size ? String(size) : undefined });
}

export async function scrobble(id: string, timeMs?: number): Promise<void> {
  await jsonRequest("scrobble", {
    id,
    submission: "true",
    time: timeMs ? String(Math.floor(timeMs)) : undefined,
  });
}

export async function setStarred(ids: string[], starred: boolean): Promise<void> {
  for (const id of ids) await jsonRequest(starred ? "star" : "unstar", { id });
}
