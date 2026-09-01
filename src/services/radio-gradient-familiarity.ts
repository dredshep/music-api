import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import type { GradientRecording } from "./radio-gradient-recording-path";
import { canonicalRadioTrackKey, type TasteTrack } from "./radio";

interface HistoryRow {
  canonical_key: string;
  artist: string;
  appearances: number;
  locally_owned: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Coarse user familiarity evidence for discovery shaping. A saved Radio
 * appearance is weaker than explicit taste/history input; local ownership adds
 * only a small bump and is never treated as proof that the recording was heard.
 *
 * Recording-graph node keys are intentionally internal to that graph. All
 * joins against the existing Radio/history/audio model use the established
 * `canonicalRadioTrackKey()` identity so old generations and new routes share
 * one exact-recording namespace.
 */
export function buildGradientFamiliarityScorer(
  stationId: string,
  tasteProfile: TasteTrack[] = [],
): (recording: GradientRecording) => number | null {
  const exact = new Map<string, number>();
  const artist = new Map<string, number>();

  for (const track of tasteProfile) {
    const weight = clamp(track.weight ?? 1, 0, 1);
    const key = canonicalRadioTrackKey(track.artist, track.title);
    exact.set(key, Math.max(exact.get(key) ?? 0, weight));
    const artistKey = normalizeForComparison(track.artist);
    artist.set(artistKey, Math.max(artist.get(artistKey) ?? 0, weight * 0.72));
  }

  let rows: HistoryRow[] = [];
  try {
    rows = getDb().query<HistoryRow, [string]>(`SELECT
        t.canonical_key,
        t.artist,
        COUNT(*) AS appearances,
        MAX(CASE WHEN t.navidrome_id IS NOT NULL THEN 1 ELSE 0 END) AS locally_owned
      FROM radio_generation_tracks t
      JOIN radio_generations g ON g.id=t.generation_id
      WHERE g.station_id=?
      GROUP BY t.canonical_key,t.artist`).all(stationId);
  } catch {
    // Familiarity is optional route shaping evidence, never a generation blocker.
  }

  for (const row of rows) {
    const exposure = clamp(0.2 + Math.log1p(row.appearances) * 0.13 + (row.locally_owned ? 0.08 : 0), 0, 0.7);
    exact.set(row.canonical_key, Math.max(exact.get(row.canonical_key) ?? 0, exposure));
    const artistKey = normalizeForComparison(row.artist);
    artist.set(artistKey, Math.max(artist.get(artistKey) ?? 0, exposure * 0.65));
  }

  return (recording) => {
    const exactValue = exact.get(canonicalRadioTrackKey(recording.artist, recording.title));
    const artistValue = artist.get(normalizeForComparison(recording.artist));
    // Absence from a bounded taste/history sample is not proof that a globally
    // famous recording is new to the listener. Keep unknown evidence neutral.
    if (exactValue == null && artistValue == null) return null;
    return clamp(Math.max(exactValue ?? 0, artistValue ?? 0), 0, 1);
  };
}
