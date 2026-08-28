import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";

const BASE_URL = "https://api.listenbrainz.org";
const LABS_URL = "https://labs.api.listenbrainz.org";
const DEFAULT_SIMILAR_RECORDINGS_ALGORITHM = "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000";

export interface LBRecordingRecommendation {
  recordingMbid: string;
  score: number;
}

export interface LBRecommendationTrack {
  recordingMbid: string;
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  score: number;
}

export interface LBSimilarRecording {
  recordingMbid: string;
  artist: string;
  title: string;
  score: number;
  rawScore: number;
}

export function isConfigured(): boolean {
  const config = getConfig();
  return config.LISTENBRAINZ_USERNAME.length > 0;
}

function requestHeaders(contentType = false) {
  const config = getConfig();
  const headers: Record<string, string> = {
    "User-Agent": "MeepMusicAPI/1.0",
    Accept: "application/json",
  };
  if (contentType) headers["Content-Type"] = "application/json";
  if (config.LISTENBRAINZ_TOKEN) headers.Authorization = `Token ${config.LISTENBRAINZ_TOKEN}`;
  return headers;
}

async function requestJson<T>(url: URL, input?: { body?: unknown; timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input?.timeoutMs ?? 15000);
  try {
    const res = await fetch(url.toString(), {
      method: input?.body === undefined ? "GET" : "POST",
      headers: requestHeaders(input?.body !== undefined),
      body: input?.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (res.status === 204) return { empty: true } as unknown as T;
    if (res.status === 429) throw new AppError("LISTENBRAINZ_RATE_LIMITED", "ListenBrainz rate limited", 429, true);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError("LISTENBRAINZ_UNAVAILABLE", `ListenBrainz returned ${res.status}: ${body.slice(0, 200)}`, 502, true);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "ListenBrainz connection failed";
    throw new AppError("LISTENBRAINZ_UNAVAILABLE", message, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

async function lbRequest<T>(path: string, input?: { params?: Record<string, string>; body?: unknown }): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(input?.params ?? {})) url.searchParams.set(key, value);
  return requestJson<T>(url, { body: input?.body });
}

async function lbFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  return lbRequest<T>(path, { params });
}

export async function ping(): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const config = getConfig();
    await lbFetch<unknown>(`/1/user/${config.LISTENBRAINZ_USERNAME}/listens`, { count: "1" });
    return true;
  } catch {
    return false;
  }
}

export async function getRecommendations(count = 100): Promise<LBRecordingRecommendation[]> {
  const config = getConfig();
  if (!isConfigured()) return [];

  log("info", "listenbrainz_get_recommendations", { count });
  const data = await lbFetch<{
    empty?: boolean;
    payload?: { mbids?: Array<{ recording_mbid: string; score?: number }>; entity?: string };
  }>(`/1/cf/recommendation/user/${config.LISTENBRAINZ_USERNAME}/recording`, { count: String(count) });

  if (data.empty || !data.payload?.mbids) {
    log("info", "listenbrainz_no_recommendations", { reason: "no listening history or recommendations not generated yet" });
    return [];
  }

  return data.payload.mbids.map((rec) => ({ recordingMbid: rec.recording_mbid, score: rec.score ?? 0 }));
}

type LBRecordingMetadata = {
  recording_name?: string;
  artist_credit_name?: string;
  recording?: { name?: string; title?: string; recording_name?: string };
  artist?: { name?: string };
  release?: { name?: string; year?: number };
};

/** Resolve collaborative-filtering MBIDs into usable artist/title candidates. */
export async function getRecommendationTracks(count = 80): Promise<LBRecommendationTrack[]> {
  const recommendations = await getRecommendations(count);
  if (!recommendations.length) return [];

  const scoreByMbid = new Map(recommendations.map((row) => [row.recordingMbid, row.score]));
  const metadata = await lbRequest<Record<string, LBRecordingMetadata>>("/1/metadata/recording/", {
    body: { recording_mbids: recommendations.map((row) => row.recordingMbid), inc: "artist release" },
  });

  const tracks: LBRecommendationTrack[] = [];
  for (const [recordingMbid, row] of Object.entries(metadata ?? {})) {
    const title = row.recording_name ?? row.recording?.name ?? row.recording?.title ?? row.recording?.recording_name ?? "";
    const artist = row.artist_credit_name ?? row.artist?.name ?? "";
    if (!artist.trim() || !title.trim()) continue;
    const rawScore = scoreByMbid.get(recordingMbid) ?? 0;
    tracks.push({
      recordingMbid,
      artist,
      title,
      album: row.release?.name ?? null,
      releaseYear: Number.isFinite(row.release?.year) ? row.release!.year! : null,
      score: Math.max(0, Math.min(1, rawScore)),
    });
  }

  log("info", "listenbrainz_resolved_recommendations", { requested: recommendations.length, resolved: tracks.length });
  return tracks;
}

function collectSimilarRows(value: unknown, output: Array<Record<string, unknown>>) {
  if (Array.isArray(value)) {
    for (const item of value) collectSimilarRows(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (typeof row.recording_mbid === "string" && (typeof row.recording_name === "string" || typeof row.artist_credit_name === "string")) {
    output.push(row);
    return;
  }
  for (const nested of Object.values(row)) collectSimilarRows(nested, output);
}

/**
 * Query ListenBrainz Labs' Similar Recordings dataset. The Labs surface is
 * experimental, so response parsing is deliberately tolerant and the caller is
 * expected to cache successful rows persistently.
 */
export async function getSimilarRecordings(recordingMbid: string, limit = 50): Promise<LBSimilarRecording[]> {
  if (!recordingMbid.trim()) return [];
  const algorithm = process.env.LISTENBRAINZ_SIMILAR_RECORDINGS_ALGORITHM?.trim() || DEFAULT_SIMILAR_RECORDINGS_ALGORITHM;
  const url = new URL(`${LABS_URL}/similar-recordings/json`);
  url.searchParams.set("recording_mbids", recordingMbid.trim());
  url.searchParams.set("algorithm", algorithm);

  const data = await requestJson<unknown>(url, { timeoutMs: 15000 });
  const rawRows: Array<Record<string, unknown>> = [];
  collectSimilarRows(data, rawRows);
  const rows = rawRows
    .filter((row) => row.recording_mbid !== recordingMbid)
    .flatMap((row) => {
      const mbid = typeof row.recording_mbid === "string" ? row.recording_mbid : "";
      const title = typeof row.recording_name === "string" ? row.recording_name : "";
      const artist = typeof row.artist_credit_name === "string" ? row.artist_credit_name : "";
      const rawScore = typeof row.score === "number" ? row.score : Number(row.score ?? 0);
      if (!mbid || !title.trim() || !artist.trim() || !Number.isFinite(rawScore) || rawScore <= 0) return [];
      return [{ recordingMbid: mbid, artist, title, rawScore }];
    })
    .slice(0, Math.max(1, limit));
  const maxScore = Math.max(1, ...rows.map((row) => row.rawScore));
  const normalized = rows.map((row) => ({ ...row, score: Math.max(0.01, Math.min(1, row.rawScore / maxScore)) }));
  log("info", "listenbrainz_similar_recordings", { recording_mbid: recordingMbid, algorithm, count: normalized.length });
  return normalized;
}
