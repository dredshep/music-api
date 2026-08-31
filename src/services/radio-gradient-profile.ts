import { getDb } from "../db/database";
import type { RadioSettings } from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";
import * as lastfm from "./lastfm";
import type { GradientRecording } from "./radio-gradient-recording-path";

export interface GradientTrackProfile {
  popularity: number | null;
  releaseYear: number | null;
  listeners: number | null;
  graphDegree: number;
  tags: string[];
  source: "spotify_history" | "lastfm" | "unknown";
}

type StoredProfileRow = { metadata_json: string | null };

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

/** Absolute scale: roughly 500 listeners is obscure and 5M is global-mainstream. */
export function normalizeGlobalPopularity(listeners: number) {
  if (!Number.isFinite(listeners) || listeners <= 0) return null;
  return clamp((Math.log10(listeners) - Math.log10(500)) / (Math.log10(5_000_000) - Math.log10(500)));
}

/** Recent means recent: an eight-year-old recording is not treated as almost-new. */
export function gradientReleaseRecency(releaseYear: number, currentYear = new Date().getUTCFullYear()) {
  const age = Math.max(0, currentYear - releaseYear);
  return clamp(Math.exp(-age / 7));
}

function parseStoredProfile(row: StoredProfileRow | null): GradientTrackProfile | null {
  if (!row?.metadata_json) return null;
  try {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const popularity = typeof metadata.popularity === "number" && Number.isFinite(metadata.popularity)
      ? clamp(metadata.popularity)
      : null;
    const releaseYear = typeof metadata.releaseYear === "number" && Number.isFinite(metadata.releaseYear)
      ? metadata.releaseYear
      : null;
    if (popularity == null && releaseYear == null) return null;
    return { popularity, releaseYear, listeners: null, graphDegree: 0, tags: [], source: "spotify_history" };
  } catch { return null; }
}

export function gradientProfileFit(
  profile: GradientTrackProfile | null,
  settings: Pick<RadioSettings, "popularityBias" | "releaseAgeBias">,
) {
  const popularity = profile?.popularity ?? 0.5;
  const recency = profile?.releaseYear ? gradientReleaseRecency(profile.releaseYear) : 0.5;
  const popularityFit = settings.popularityBias < 0 ? 1 - popularity : popularity;
  const releaseFit = settings.releaseAgeBias < 0 ? 1 - recency : recency;
  const popularityWeight = Math.abs(settings.popularityBias);
  const releaseWeight = Math.abs(settings.releaseAgeBias);

  // Hub penalty: when rarity is strongly requested, recordings that are central
  // graph hubs (high degree) should be penalized even if their absolute
  // listener count looks moderate. This prevents genre megastars from slipping
  // through rarity filters just because their global audience is smaller than
  // pop stars. The penalty only applies when popularityBias is negative (rare).
  let hubPenalty = 0;
  if (settings.popularityBias < -0.3 && profile?.graphDegree) {
    const hubness = clamp(Math.log1p(profile.graphDegree) / Math.log1p(200), 0, 1);
    hubPenalty = hubness * Math.abs(settings.popularityBias) * 0.25;
  }

  const total = popularityWeight + releaseWeight;
  const baseFit = total > 0
    ? (popularityFit * popularityWeight + releaseFit * releaseWeight) / total
    : 0.5;
  return clamp(baseFit - hubPenalty, 0, 1);
}

/** Cached per generation; prior Spotify resolution wins over coarse Last.fm evidence. */
export function createGradientTrackProfileResolver() {
  const cache = new Map<string, Promise<GradientTrackProfile>>();
  let degreesLoaded = false;
  const degrees = new Map<string, number>();
  const loadDegrees = () => {
    if (degreesLoaded) return;
    degreesLoaded = true;
    try {
      const rows = getDb().query<{ source_key: string; deg: number }, []>(
        `SELECT source_key, COUNT(*) AS deg FROM recording_similarity_edges GROUP BY source_key`,
      ).all();
      for (const row of rows) degrees.set(row.source_key, row.deg);
    } catch { /* standalone tests */ }
  };
  return (recording: GradientRecording): Promise<GradientTrackProfile> => {
    const key = `text:${normalizeForComparison(recording.artist)}|${normalizeForComparison(recording.title)}`;
    const existing = cache.get(key);
    if (existing) return existing;
    loadDegrees();
    const degree = degrees.get(key) ?? degrees.get(recording.key) ?? 0;
    const promise: Promise<GradientTrackProfile> = (async () => {
      let fromHistory: GradientTrackProfile | null = null;
      try {
        const stored = getDb().query<StoredProfileRow, [string]>(`SELECT metadata_json
          FROM radio_generation_tracks
          WHERE canonical_key=? AND metadata_json IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`).get(key) ?? null;
        fromHistory = parseStoredProfile(stored);
        if (fromHistory) fromHistory = { ...fromHistory, graphDegree: degree };
      } catch { /* standalone planner tests and degraded DB state use provider evidence only */ }
      if (fromHistory?.popularity != null && fromHistory.releaseYear != null) return fromHistory;
      if (!process.env.LASTFM_API_KEY?.trim()) {
        return fromHistory ?? { popularity: null, releaseYear: null, listeners: null, graphDegree: degree, tags: [], source: "unknown" };
      }
      try {
        const profile = await lastfm.getTrackProfile(recording.artist, recording.title);
        return {
          popularity: fromHistory?.popularity ?? normalizeGlobalPopularity(profile.listeners),
          releaseYear: fromHistory?.releaseYear ?? profile.releaseYear,
          listeners: profile.listeners || null,
          graphDegree: degree,
          tags: profile.tags ?? [],
          source: fromHistory ? "spotify_history" : "lastfm",
        };
      } catch {
        return fromHistory ?? { popularity: null, releaseYear: null, listeners: null, graphDegree: degree, tags: [], source: "unknown" };
      }
    })();
    cache.set(key, promise);
    return promise;
  };
}
