import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";
import { similarityScore } from "../domain/normalization";

const BASE_URL = "https://lrclib.net/api";
const USER_AGENT = "MeepMusicAutomation/1.0";
const TIMEOUT_MS = 10_000;

export interface LrclibTrack {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface LrclibMatch {
  lrclibId: number;
  trackName: string;
  artistName: string;
  albumName: string;
  durationS: number;
  durationDeltaS: number;
  instrumental: boolean;
  hasSynced: boolean;
  hasPlain: boolean;
  matchType: "exact" | "search";
  confidence: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

async function lrclibFetch<T>(
  path: string,
  params?: Record<string, string>
): Promise<T | null> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 404) return null;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError(
        "LRCLIB_ERROR",
        `LRCLIB returned ${res.status}: ${body.slice(0, 200)}`,
        502,
        true
      );
    }

    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "LRCLIB request failed";
    throw new AppError("LRCLIB_ERROR", message, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getExact(params: {
  trackName: string;
  artistName: string;
  albumName?: string;
  durationS?: number;
}): Promise<LrclibTrack | null> {
  const query: Record<string, string> = {
    track_name: params.trackName,
    artist_name: params.artistName,
  };
  if (params.albumName) query.album_name = params.albumName;
  if (params.durationS != null) query.duration = String(Math.round(params.durationS));

  return lrclibFetch<LrclibTrack>("/get", query);
}

export async function getById(id: number): Promise<LrclibTrack | null> {
  return lrclibFetch<LrclibTrack>(`/get/${id}`);
}

export async function search(params: {
  q?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
}): Promise<LrclibTrack[]> {
  const query: Record<string, string> = {};
  if (params.q) query.q = params.q;
  if (params.trackName) query.track_name = params.trackName;
  if (params.artistName) query.artist_name = params.artistName;
  if (params.albumName) query.album_name = params.albumName;

  if (!query.q && !query.track_name) return [];

  const results = await lrclibFetch<LrclibTrack[]>("/search", query);
  return results ?? [];
}

/**
 * Search LRCLIB for the best lyrics match. Tries exact match first,
 * falls back to keyword search, then ranks by confidence.
 */
export async function findBestMatches(params: {
  artist: string;
  title: string;
  album?: string;
  durationS?: number;
  maxResults?: number;
}): Promise<LrclibMatch[]> {
  const { artist, title, album, durationS, maxResults = 10 } = params;
  const matches: LrclibMatch[] = [];

  // Try exact match first
  const exact = await getExact({
    trackName: title,
    artistName: artist,
    albumName: album,
    durationS,
  });

  if (exact) {
    matches.push(trackToMatch(exact, "exact", artist, title, durationS));
  }

  // Search for more candidates
  const searchResults = await search({
    trackName: title,
    artistName: artist,
    albumName: album,
  });

  for (const track of searchResults) {
    if (exact && track.id === exact.id) continue;
    matches.push(trackToMatch(track, "search", artist, title, durationS));
  }

  // If exact match failed and search had no results, try a broader query
  if (matches.length === 0) {
    const broadResults = await search({ q: `${artist} ${title}` });
    for (const track of broadResults) {
      matches.push(trackToMatch(track, "search", artist, title, durationS));
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);

  log("info", "lrclib_search", {
    artist,
    title,
    album,
    duration_s: durationS,
    exact_found: !!exact,
    total_matches: matches.length,
  });

  return matches.slice(0, maxResults);
}

function trackToMatch(
  track: LrclibTrack,
  matchType: "exact" | "search",
  queryArtist: string,
  queryTitle: string,
  queryDurationS?: number
): LrclibMatch {
  const durationDelta = queryDurationS != null
    ? Math.abs(track.duration - queryDurationS)
    : -1;

  const confidence = computeConfidence({
    matchType,
    queryArtist,
    queryTitle,
    trackArtist: track.artistName,
    trackTitle: track.trackName,
    durationDeltaS: durationDelta >= 0 ? durationDelta : undefined,
    hasSynced: track.syncedLyrics != null,
  });

  return {
    lrclibId: track.id,
    trackName: track.trackName,
    artistName: track.artistName,
    albumName: track.albumName,
    durationS: track.duration,
    durationDeltaS: durationDelta >= 0 ? Math.round(durationDelta * 10) / 10 : -1,
    instrumental: track.instrumental,
    hasSynced: track.syncedLyrics != null && track.syncedLyrics.length > 0,
    hasPlain: track.plainLyrics != null && track.plainLyrics.length > 0,
    matchType,
    confidence,
    syncedLyrics: track.syncedLyrics,
    plainLyrics: track.plainLyrics,
  };
}

function computeConfidence(params: {
  matchType: "exact" | "search";
  queryArtist: string;
  queryTitle: string;
  trackArtist: string;
  trackTitle: string;
  durationDeltaS?: number;
  hasSynced: boolean;
}): number {
  let conf = params.matchType === "exact" ? 0.85 : 0.5;

  const artistSim = similarityScore(params.queryArtist, params.trackArtist);
  const titleSim = similarityScore(params.queryTitle, params.trackTitle);

  conf += artistSim * 0.05;
  conf += titleSim * 0.05;

  if (params.durationDeltaS != null) {
    if (params.durationDeltaS <= 1) conf += 0.04;
    else if (params.durationDeltaS <= 3) conf += 0.02;
    else if (params.durationDeltaS > 10) conf -= 0.1;
  }

  if (params.hasSynced) conf += 0.01;

  return Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
}
