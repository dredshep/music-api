import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

export interface LastFmArtist {
  name: string;
  mbid: string;
  playcount: number;
  rank: number;
  url: string;
}

export interface LastFmSimilarArtist {
  name: string;
  mbid: string;
  match: number;
  url: string;
}

export interface LastFmRecentTrack {
  name: string;
  artist: string;
  artistMbid: string;
  album: string;
  albumMbid: string;
  date: string | null;
  nowPlaying: boolean;
}

export type LastFmPeriod = "7day" | "1month" | "3month" | "6month" | "12month" | "overall";

async function lastfmFetch<T>(params: Record<string, string>): Promise<T> {
  const config = getConfig();
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", config.LASTFM_API_KEY);
  url.searchParams.set("format", "json");

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "MeepMusicAPI/1.0" },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");

      if (res.status === 429) {
        throw new AppError(
          "LASTFM_RATE_LIMITED",
          `Last.fm rate limited: ${body.slice(0, 200)}`,
          429,
          true
        );
      }

      throw new AppError(
        "LASTFM_UNAVAILABLE",
        `Last.fm returned ${res.status}: ${body.slice(0, 200)}`,
        502,
        true
      );
    }

    const data = (await res.json()) as Record<string, unknown>;

    if (data.error) {
      throw new AppError(
        "LASTFM_API_ERROR",
        `Last.fm error ${data.error}: ${(data.message as string) ?? "unknown"}`,
        502,
        data.error === 29
      );
    }

    return data as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Last.fm connection failed";
    throw new AppError("LASTFM_UNAVAILABLE", message, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function ping(): Promise<boolean> {
  try {
    const config = getConfig();
    await lastfmFetch<unknown>({
      method: "user.getInfo",
      user: config.LASTFM_USERNAME,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getTopArtists(
  period: LastFmPeriod = "overall",
  limit = 50
): Promise<LastFmArtist[]> {
  const config = getConfig();

  log("info", "lastfm_get_top_artists", { period, limit });

  const data = await lastfmFetch<{
    topartists?: { artist?: Array<{
      name: string;
      mbid?: string;
      playcount: string;
      "@attr"?: { rank: string };
      url?: string;
    }> };
  }>({
    method: "user.getTopArtists",
    user: config.LASTFM_USERNAME,
    period,
    limit: String(limit),
  });

  const artists = data.topartists?.artist ?? [];

  return artists.map((a, idx) => ({
    name: a.name,
    mbid: a.mbid ?? "",
    playcount: parseInt(a.playcount, 10) || 0,
    rank: parseInt(a["@attr"]?.rank ?? String(idx + 1), 10),
    url: a.url ?? "",
  }));
}

export async function getSimilarArtists(
  artist: string,
  limit = 30
): Promise<LastFmSimilarArtist[]> {
  log("info", "lastfm_get_similar", { artist, limit });

  const data = await lastfmFetch<{
    similarartists?: { artist?: Array<{
      name: string;
      mbid?: string;
      match: string;
      url?: string;
    }> };
  }>({
    method: "artist.getSimilar",
    artist,
    limit: String(limit),
    autocorrect: "1",
  });

  const similar = data.similarartists?.artist ?? [];

  return similar.map((a) => ({
    name: a.name,
    mbid: a.mbid ?? "",
    match: parseFloat(a.match) || 0,
    url: a.url ?? "",
  }));
}

export async function getRecentTracks(
  limit = 50
): Promise<LastFmRecentTrack[]> {
  const config = getConfig();

  const data = await lastfmFetch<{
    recenttracks?: { track?: Array<{
      name: string;
      artist?: { "#text"?: string; mbid?: string };
      album?: { "#text"?: string; mbid?: string };
      date?: { uts: string };
      "@attr"?: { nowplaying?: string };
    }> };
  }>({
    method: "user.getRecentTracks",
    user: config.LASTFM_USERNAME,
    limit: String(limit),
    extended: "0",
  });

  const tracks = data.recenttracks?.track ?? [];

  return tracks.map((t) => ({
    name: t.name,
    artist: t.artist?.["#text"] ?? "",
    artistMbid: t.artist?.mbid ?? "",
    album: t.album?.["#text"] ?? "",
    albumMbid: t.album?.mbid ?? "",
    date: t.date?.uts ? new Date(parseInt(t.date.uts, 10) * 1000).toISOString() : null,
    nowPlaying: t["@attr"]?.nowplaying === "true",
  }));
}
