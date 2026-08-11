import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";

const BASE_URL = "https://api.listenbrainz.org";

export interface LBRecordingRecommendation {
  recordingMbid: string;
  score: number;
}

export function isConfigured(): boolean {
  const config = getConfig();
  return config.LISTENBRAINZ_USERNAME.length > 0;
}

async function lbFetch<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const config = getConfig();
  const url = new URL(`${BASE_URL}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "MeepMusicAPI/1.0",
    Accept: "application/json",
  };

  if (config.LISTENBRAINZ_TOKEN) {
    headers["Authorization"] = `Token ${config.LISTENBRAINZ_TOKEN}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    });

    if (res.status === 204) {
      return { empty: true } as unknown as T;
    }

    if (res.status === 429) {
      throw new AppError(
        "LISTENBRAINZ_RATE_LIMITED",
        "ListenBrainz rate limited",
        429,
        true
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError(
        "LISTENBRAINZ_UNAVAILABLE",
        `ListenBrainz returned ${res.status}: ${body.slice(0, 200)}`,
        502,
        true
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

export async function ping(): Promise<boolean> {
  if (!isConfigured()) return false;

  try {
    const config = getConfig();
    await lbFetch<unknown>(`/1/user/${config.LISTENBRAINZ_USERNAME}/listens`, {
      count: "1",
    });
    return true;
  } catch {
    return false;
  }
}

export async function getRecommendations(
  count = 100
): Promise<LBRecordingRecommendation[]> {
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
