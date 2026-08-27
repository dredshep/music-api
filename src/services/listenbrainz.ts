import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";

const BASE_URL = "https://api.listenbrainz.org";

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

async function lbRequest<T>(
  path: string,
  input?: { params?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(input?.params ?? {})) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url.toString(), {
      method: input?.body === undefined ? "GET" : "POST",
      headers: requestHeaders(input?.body !== undefined),
      body: input?.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });

    if (res.status === 204) return { empty: true } as unknown as T;
    if (res.status === 429) {
      throw new AppError("LISTENBRAINZ_RATE_LIMITED", "ListenBrainz rate limited", 429, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError(
        "LISTENBRAINZ_UNAVAILABLE",
        `ListenBrainz returned ${res.status}: ${body.slice(0, 200)}`,
        502,
        true,
      );
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
    payload?: {
      mbids?: Array<{ recording_mbid: string; score?: number }>;
      entity?: string;
    };
  }>(`/1/cf/recommendation/user/${config.LISTENBRAINZ_USERNAME}/recording`, {
    count: String(count),
  });

  if (data.empty || !data.payload?.mbids) {
    log("info", "listenbrainz_no_recommendations", {
      reason: "no listening history or recommendations not generated yet",
    });
    return [];
  }

  return data.payload.mbids.map((rec) => ({
    recordingMbid: rec.recording_mbid,
    score: rec.score ?? 0,
  }));
}

type LBRecordingMetadata = {
  recording_name?: string;
  artist_credit_name?: string;
  recording?: {
    name?: string;
    title?: string;
    recording_name?: string;
  };
  artist?: {
    name?: string;
  };
  release?: {
    name?: string;
    year?: number;
  };
};

/** Resolve collaborative-filtering MBIDs into usable artist/title candidates. */
export async function getRecommendationTracks(count = 80): Promise<LBRecommendationTrack[]> {
  const recommendations = await getRecommendations(count);
  if (!recommendations.length) return [];

  const scoreByMbid = new Map(recommendations.map((row) => [row.recordingMbid, row.score]));
  const metadata = await lbRequest<Record<string, LBRecordingMetadata>>("/1/metadata/recording/", {
    body: {
      recording_mbids: recommendations.map((row) => row.recordingMbid),
      inc: "artist release",
    },
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

  log("info", "listenbrainz_resolved_recommendations", {
    requested: recommendations.length,
    resolved: tracks.length,
  });
  return tracks;
}
