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

export interface LastFmTrack {
  name: string;
  artist: string;
  artistMbid: string;
  mbid: string;
  url: string;
  match: number;
  playcount: number;
  rank: number;
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

export interface LastFmTrackProfile {
  listeners: number;
  playcount: number;
  releaseYear: number | null;
  tags: string[];
}

export type LastFmPeriod = "7day" | "1month" | "3month" | "6month" | "12month" | "overall";

async function lastfmFetch<T>(params: Record<string, string>): Promise<T> {
  const config = getConfig();
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", config.LASTFM_API_KEY);
  url.searchParams.set("format", "json");

  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

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
        throw new AppError("LASTFM_RATE_LIMITED", `Last.fm rate limited: ${body.slice(0, 200)}`, 429, true);
      }
      throw new AppError("LASTFM_UNAVAILABLE", `Last.fm returned ${res.status}: ${body.slice(0, 200)}`, 502, true);
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) {
      throw new AppError(
        "LASTFM_API_ERROR",
        `Last.fm error ${data.error}: ${(data.message as string) ?? "unknown"}`,
        502,
        data.error === 29,
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
    await lastfmFetch<unknown>({ method: "user.getInfo", user: config.LASTFM_USERNAME });
    return true;
  } catch {
    return false;
  }
}

export async function getTopArtists(period: LastFmPeriod = "overall", limit = 50): Promise<LastFmArtist[]> {
  const config = getConfig();
  log("info", "lastfm_get_top_artists", { period, limit });
  const data = await lastfmFetch<{
    topartists?: { artist?: Array<{ name: string; mbid?: string; playcount: string; "@attr"?: { rank: string }; url?: string }> };
  }>({ method: "user.getTopArtists", user: config.LASTFM_USERNAME, period, limit: String(limit) });
  const artists = data.topartists?.artist ?? [];
  return artists.map((a, idx) => ({
    name: a.name,
    mbid: a.mbid ?? "",
    playcount: parseInt(a.playcount, 10) || 0,
    rank: parseInt(a["@attr"]?.rank ?? String(idx + 1), 10),
    url: a.url ?? "",
  }));
}

export async function getSimilarArtists(artist: string, limit = 30): Promise<LastFmSimilarArtist[]> {
  log("info", "lastfm_get_similar", { artist, limit });
  const data = await lastfmFetch<{
    similarartists?: { artist?: Array<{ name: string; mbid?: string; match: string; url?: string }> };
  }>({ method: "artist.getSimilar", artist, limit: String(limit), autocorrect: "1" });
  const similar = data.similarartists?.artist ?? [];
  return similar.map((a) => ({
    name: a.name,
    mbid: a.mbid ?? "",
    match: parseFloat(a.match) || 0,
    url: a.url ?? "",
  }));
}

export async function getArtistTopTracks(artist: string, limit = 20): Promise<LastFmTrack[]> {
  const data = await lastfmFetch<{
    toptracks?: { track?: Array<{
      name: string;
      mbid?: string;
      playcount?: string;
      url?: string;
      artist?: { name?: string; mbid?: string };
      "@attr"?: { rank?: string };
    }> };
  }>({ method: "artist.getTopTracks", artist, limit: String(limit), autocorrect: "1" });
  const tracks = data.toptracks?.track ?? [];
  const maxPlaycount = Math.max(1, ...tracks.map((t) => parseInt(t.playcount ?? "0", 10) || 0));
  return tracks.map((t, idx) => ({
    name: t.name,
    artist: t.artist?.name ?? artist,
    artistMbid: t.artist?.mbid ?? "",
    mbid: t.mbid ?? "",
    url: t.url ?? "",
    match: (parseInt(t.playcount ?? "0", 10) || 0) / maxPlaycount,
    playcount: parseInt(t.playcount ?? "0", 10) || 0,
    rank: parseInt(t["@attr"]?.rank ?? String(idx + 1), 10),
  }));
}

export async function getSimilarTracks(artist: string, track: string, limit = 30): Promise<LastFmTrack[]> {
  const data = await lastfmFetch<{
    similartracks?: { track?: Array<{
      name: string;
      mbid?: string;
      match?: string;
      url?: string;
      artist?: { name?: string; mbid?: string };
    }> };
  }>({ method: "track.getSimilar", artist, track, limit: String(limit), autocorrect: "1" });
  const tracks = data.similartracks?.track ?? [];
  return tracks.map((t, idx) => ({
    name: t.name,
    artist: t.artist?.name ?? "",
    artistMbid: t.artist?.mbid ?? "",
    mbid: t.mbid ?? "",
    url: t.url ?? "",
    match: parseFloat(t.match ?? "0") || 0,
    playcount: 0,
    rank: idx + 1,
  }));
}

function releaseYearFromTags(tags: string[]) {
  const currentYear = new Date().getUTCFullYear();
  for (const tag of tags) {
    const exact = tag.trim().match(/^(19\d{2}|20\d{2})$/)?.[1];
    if (exact) {
      const year = Number(exact);
      if (year >= 1900 && year <= currentYear + 1) return year;
    }
  }
  for (const tag of tags) {
    const decade = tag.toLowerCase().match(/\b(19\d|20\d)0s\b/)?.[1];
    if (decade) return Number(`${decade}5`);
  }
  return null;
}

/** Independent global popularity and coarse release-era evidence for Radio. */
export async function getTrackProfile(artist: string, track: string): Promise<LastFmTrackProfile> {
  const data = await lastfmFetch<{
    track?: {
      listeners?: string;
      playcount?: string;
      album?: { title?: string };
      toptags?: { tag?: Array<{ name?: string }> };
    };
  }>({ method: "track.getInfo", artist, track, autocorrect: "1" });
  const tags = (data.track?.toptags?.tag ?? []).map((row) => row.name?.trim() ?? "").filter(Boolean);
  let releaseYear = releaseYearFromTags(tags);

  // Last.fm's wiki publication timestamp is an edit date, not a release date.
  // Album tags often carry a useful year/decade, so use only those tags.
  const album = data.track?.album?.title?.trim();
  if (!releaseYear && album) {
    try {
      const albumData = await lastfmFetch<{ album?: { tags?: { tag?: Array<{ name?: string }> } } }>({
        method: "album.getInfo", artist, album, autocorrect: "1",
      });
      const albumTags = (albumData.album?.tags?.tag ?? []).map((row) => row.name?.trim() ?? "").filter(Boolean);
      tags.push(...albumTags.filter((tag) => !tags.includes(tag)));
      releaseYear = releaseYearFromTags(albumTags);
    } catch { /* popularity is still useful when album metadata is absent */ }
  }

  return {
    listeners: Math.max(0, Number(data.track?.listeners ?? 0) || 0),
    playcount: Math.max(0, Number(data.track?.playcount ?? 0) || 0),
    releaseYear,
    tags,
  };
}

export async function getTagTopTracks(tag: string, limit = 30): Promise<LastFmTrack[]> {
  const data = await lastfmFetch<{
    tracks?: { track?: Array<{
      name: string;
      mbid?: string;
      url?: string;
      artist?: { name?: string; mbid?: string };
      "@attr"?: { rank?: string };
    }> };
  }>({ method: "tag.getTopTracks", tag, limit: String(limit) });
  const tracks = data.tracks?.track ?? [];
  return tracks.map((t, idx) => ({
    name: t.name,
    artist: t.artist?.name ?? "",
    artistMbid: t.artist?.mbid ?? "",
    mbid: t.mbid ?? "",
    url: t.url ?? "",
    match: 1 - idx / Math.max(1, tracks.length),
    playcount: 0,
    rank: parseInt(t["@attr"]?.rank ?? String(idx + 1), 10),
  }));
}

export async function getAlbumTracks(artist: string, album: string): Promise<LastFmTrack[]> {
  const data = await lastfmFetch<{
    album?: { tracks?: { track?: Array<{ name: string; mbid?: string; url?: string; artist?: { name?: string; mbid?: string }; "@attr"?: { rank?: string } }> } };
  }>({ method: "album.getInfo", artist, album, autocorrect: "1" });
  const tracks = data.album?.tracks?.track ?? [];
  return tracks.map((t, idx) => ({
    name: t.name,
    artist: t.artist?.name ?? artist,
    artistMbid: t.artist?.mbid ?? "",
    mbid: t.mbid ?? "",
    url: t.url ?? "",
    match: 1 - idx / Math.max(1, tracks.length * 2),
    playcount: 0,
    rank: parseInt(t["@attr"]?.rank ?? String(idx + 1), 10),
  }));
}

export async function getUserTopTracks(period: LastFmPeriod = "overall", limit = 100): Promise<LastFmTrack[]> {
  const config = getConfig();
  const data = await lastfmFetch<{
    toptracks?: { track?: Array<{
      name: string;
      mbid?: string;
      playcount?: string;
      url?: string;
      artist?: { name?: string; mbid?: string };
      "@attr"?: { rank?: string };
    }> };
  }>({ method: "user.getTopTracks", user: config.LASTFM_USERNAME, period, limit: String(limit) });
  const tracks = data.toptracks?.track ?? [];
  const maxPlaycount = Math.max(1, ...tracks.map((t) => parseInt(t.playcount ?? "0", 10) || 0));
  return tracks.map((t, idx) => ({
    name: t.name,
    artist: t.artist?.name ?? "",
    artistMbid: t.artist?.mbid ?? "",
    mbid: t.mbid ?? "",
    url: t.url ?? "",
    match: (parseInt(t.playcount ?? "0", 10) || 0) / maxPlaycount,
    playcount: parseInt(t.playcount ?? "0", 10) || 0,
    rank: parseInt(t["@attr"]?.rank ?? String(idx + 1), 10),
  }));
}

export async function getRecentTracks(limit = 50): Promise<LastFmRecentTrack[]> {
  const config = getConfig();
  const data = await lastfmFetch<{
    recenttracks?: { track?: Array<{
      name: string;
      artist?: { "#text"?: string; mbid?: string };
      album?: { "#text"?: string; mbid?: string };
      date?: { uts: string };
      "@attr"?: { nowplaying?: string };
    }> };
  }>({ method: "user.getRecentTracks", user: config.LASTFM_USERNAME, limit: String(limit), extended: "0" });
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
