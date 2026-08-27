import { getGenerationTracks, listGenerations } from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";

export type RadioHistoryPenalties = {
  tracks: Map<string, number>;
  artists: Map<string, number>;
};

/**
 * Continuous repeat pressure across prior saved generations.
 *
 * Recent generations matter much more than old ones, and tracks later in the
 * sampled history matter less. This complements the within-generation artist
 * cooldown rather than replacing it. Old music is never permanently excluded.
 */
export function buildRadioHistoryPenalties(
  stationId: string,
  maxTracks: number,
  nowMs = Date.now(),
): RadioHistoryPenalties {
  const tracks = new Map<string, number>();
  const artists = new Map<string, number>();
  if (maxTracks <= 0) return { tracks, artists };

  let observed = 0;
  const horizon = Math.max(1, maxTracks);
  for (const generation of listGenerations(stationId)) {
    const created = Date.parse(generation.created_at);
    const ageDays = Number.isFinite(created) ? Math.max(0, (nowMs - created) / 86_400_000) : 365;
    // A generation from a week ago retains ~61% pressure; a month-old one ~12%.
    const timeDecay = Math.exp(-ageDays / 14);
    if (timeDecay < 0.01) break;

    for (const track of getGenerationTracks(generation.id)) {
      if (observed >= horizon) return { tracks, artists };
      const sequenceDecay = Math.exp(-observed / Math.max(8, horizon / 3));
      const pressure = Math.max(0, Math.min(1, timeDecay * sequenceDecay));
      tracks.set(track.canonical_key, Math.max(tracks.get(track.canonical_key) ?? 0, pressure));
      const artistKey = normalizeForComparison(track.artist);
      artists.set(artistKey, Math.max(artists.get(artistKey) ?? 0, pressure * 0.55));
      observed++;
    }
  }

  return { tracks, artists };
}
