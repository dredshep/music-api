import { getDb } from "../db/database";
import {
  getGeneration,
  getGenerationTracks,
  parseRadioSettings,
  type RadioSettings,
  type RadioTrackRow,
} from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";

interface AnalysisRow {
  bpm: number | null;
  musical_key: string | null;
  mode: string | null;
  loudness: number | null;
  energy: number | null;
  timbre_json: string | null;
  intro_json: string | null;
  outro_json: string | null;
}

export interface TrackFeatures {
  bpm?: number;
  key?: string;
  mode?: string;
  loudness?: number;
  energy?: number;
  timbre?: Record<string, number>;
  intro?: Record<string, number>;
  outro?: Record<string, number>;
  genreSeed?: string;
}

function parseObject(raw: string | null): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const numeric: Record<string, number> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item)) numeric[key] = item;
    }
    return Object.keys(numeric).length ? numeric : undefined;
  } catch {
    return undefined;
  }
}

function metadataObject(track: RadioTrackRow): Record<string, unknown> {
  try { return track.metadata_json ? JSON.parse(track.metadata_json) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function isGradientWaypoint(track: RadioTrackRow) {
  return metadataObject(track).gradientWaypoint === true;
}

function loadFeatures(track: RadioTrackRow): TrackFeatures {
  const row = getDb().query<AnalysisRow, [string]>(`SELECT bpm,musical_key,mode,loudness,energy,timbre_json,intro_json,outro_json
      FROM track_audio_analysis
      WHERE canonical_key=? AND status='ready'
      ORDER BY analysis_version DESC LIMIT 1`).get(track.canonical_key);
  const metadata = metadataObject(track);
  return {
    bpm: row?.bpm ?? undefined,
    key: row?.musical_key ?? undefined,
    mode: row?.mode ?? undefined,
    loudness: row?.loudness ?? undefined,
    energy: row?.energy ?? undefined,
    timbre: parseObject(row?.timbre_json ?? null),
    intro: parseObject(row?.intro_json ?? null),
    outro: parseObject(row?.outro_json ?? null),
    genreSeed: typeof metadata.genreSeed === "string" ? metadata.genreSeed : undefined,
  };
}

const KEY_INDEX: Record<string, number> = {
  C: 0, "B#": 0,
  "C#": 1, Db: 1,
  D: 2,
  "D#": 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, "E#": 5,
  "F#": 6, Gb: 6,
  G: 7,
  "G#": 8, Ab: 8,
  A: 9,
  "A#": 10, Bb: 10,
  B: 11, Cb: 11,
};

export function keyCompatibility(a: TrackFeatures, b: TrackFeatures): number | null {
  if (!a.key || !b.key) return null;
  const ai = KEY_INDEX[a.key];
  const bi = KEY_INDEX[b.key];
  if (ai == null || bi == null) return a.key === b.key ? 1 : 0.35;
  const delta = (bi - ai + 12) % 12;
  const sameMode = Boolean(a.mode && b.mode && a.mode === b.mode);
  if (delta === 0 && sameMode) return 1;
  if (delta === 0) return 0.72;
  if (!sameMode && (delta === 3 || delta === 9)) return 0.9;
  if (delta === 5 || delta === 7) return sameMode ? 0.82 : 0.7;
  if (delta === 1 || delta === 11 || delta === 2 || delta === 10) return 0.42;
  return 0.25;
}

export function tempoCompatibility(a?: number, b?: number): number | null {
  if (!a || !b) return null;
  const diffs = [Math.abs(a - b), Math.abs(a * 2 - b), Math.abs(a - b * 2)];
  const diff = Math.min(...diffs);
  return Math.max(0, 1 - diff / 45);
}

function scalarSimilarity(a: number | undefined, b: number | undefined, range = 1): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, 1 - Math.abs(a - b) / range);
}

export function timbreSimilarity(a?: Record<string, number>, b?: Record<string, number>): number | null {
  if (!a || !b) return null;
  const dimensions: Array<[string, number]> = [
    ["spectral_centroid_mean", 3500],
    ["spectral_centroid_std", 2200],
    ["zero_crossing_rate_mean", 0.25],
  ];
  const scores: number[] = [];
  for (const [key, range] of dimensions) {
    if (a[key] == null || b[key] == null) continue;
    scores.push(Math.max(0, 1 - Math.abs(a[key]! - b[key]!) / range));
  }
  return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
}

export function introOutroCompatibility(outro?: Record<string, number>, intro?: Record<string, number>): number | null {
  if (!outro || !intro) return null;
  if (outro.dbfs != null && intro.dbfs != null) {
    return Math.max(0, 1 - Math.abs(outro.dbfs - intro.dbfs) / 24);
  }
  if (outro.rms != null && intro.rms != null) {
    return Math.max(0, 1 - Math.abs(outro.rms - intro.rms) / 0.35);
  }
  return null;
}

function semanticCompatibility(a: RadioTrackRow, b: RadioTrackRow, af: TrackFeatures, bf: TrackFeatures): number | null {
  if (a.album && b.album && normalizeForComparison(a.album) === normalizeForComparison(b.album)) return 1;
  if (af.genreSeed && bf.genreSeed && normalizeForComparison(af.genreSeed) === normalizeForComparison(bf.genreSeed)) return 0.95;
  if (normalizeForComparison(a.artist) === normalizeForComparison(b.artist)) return 0.82;
  if (a.trajectory_position != null && b.trajectory_position != null) {
    return Math.max(0, 1 - Math.abs(a.trajectory_position - b.trajectory_position) * 3);
  }
  return null;
}

export function radioTransitionScore(
  a: RadioTrackRow | null,
  b: RadioTrackRow,
  settings: RadioSettings,
  features: Map<string, TrackFeatures>,
): number {
  if (!a || settings.djFlow <= 0) return 0;
  const af = features.get(a.id) ?? {};
  const bf = features.get(b.id) ?? {};
  const weighted: Array<[number | null, number]> = [
    [tempoCompatibility(af.bpm, bf.bpm), settings.djWeights.tempo ?? 0],
    [keyCompatibility(af, bf), settings.djWeights.key ?? 0],
    [scalarSimilarity(af.energy, bf.energy, 1), settings.djWeights.energy ?? 0],
    [timbreSimilarity(af.timbre, bf.timbre), settings.djWeights.timbre ?? 0],
    [introOutroCompatibility(af.outro, bf.intro), settings.djWeights.introOutro ?? 0],
    [semanticCompatibility(a, b, af, bf), settings.djWeights.semantic ?? 0],
  ].filter(([, weight]) => weight > 0);

  let weightedTotal = 0;
  let activeWeight = 0;
  for (const [score, weight] of weighted) {
    if (score == null) continue;
    weightedTotal += score * weight;
    activeWeight += weight;
  }
  let result = activeWeight > 0 ? weightedTotal / activeWeight : 0;

  if (normalizeForComparison(a.artist) === normalizeForComparison(b.artist)) {
    result -= (settings.djWeights.artistSpacing ?? 0) * settings.repeatStrength;
  }
  return result * settings.djFlow;
}

/**
 * Gradient generations already encode their musical path in trajectory_position.
 * DJ flow may improve local hand-offs, but must never turn an A→B journey into a
 * globally reordered playlist. Allow only a small neighbourhood around the
 * original trajectory target and heavily penalize displacement inside it.
 */
function trajectoryScore(track: RadioTrackRow, absolutePosition: number, totalTracks: number): number {
  if (track.trajectory_position == null || totalTracks <= 1) return 0;
  const target = absolutePosition / (totalTracks - 1);
  const distance = Math.abs(track.trajectory_position - target);
  const maxLocalMove = Math.max(0.08, 2 / (totalTracks - 1));
  if (distance > maxLocalMove) return -Infinity;
  return -distance * 3;
}

function segmentOrder(
  segment: RadioTrackRow[],
  segmentStart: number,
  totalTracks: number,
  previous: RadioTrackRow | null,
  nextLocked: RadioTrackRow | null,
  settings: RadioSettings,
  features: Map<string, TrackFeatures>,
): RadioTrackRow[] {
  if (segment.length <= 1 || settings.djFlow <= 0) return segment;
  const remaining = [...segment];
  const ordered: RadioTrackRow[] = [];
  let prev = previous;

  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    const absolutePosition = segmentStart + ordered.length;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const trajectory = trajectoryScore(candidate, absolutePosition, totalTracks);
      if (trajectory === -Infinity) continue;
      let score = radioTransitionScore(prev, candidate, settings, features) + trajectory;
      if (remaining.length <= 3 && nextLocked) {
        score += radioTransitionScore(candidate, nextLocked, settings, features) * 0.35;
      }
      score -= candidate.position * 1e-6;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    ordered.push(chosen!);
    prev = chosen!;
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < ordered.length - 1; i++) {
      const absoluteA = segmentStart + i;
      const absoluteB = absoluteA + 1;
      const leftContext = i === 0 ? previous : ordered[i - 1]!;
      const a = ordered[i]!;
      const b = ordered[i + 1]!;
      const rightContext = i + 2 < ordered.length ? ordered[i + 2]! : nextLocked;
      const beforeTrajectory = trajectoryScore(a, absoluteA, totalTracks) + trajectoryScore(b, absoluteB, totalTracks);
      const afterTrajectory = trajectoryScore(b, absoluteA, totalTracks) + trajectoryScore(a, absoluteB, totalTracks);
      if (afterTrajectory === -Infinity) continue;
      const before = radioTransitionScore(leftContext, a, settings, features)
        + radioTransitionScore(a, b, settings, features)
        + (rightContext ? radioTransitionScore(b, rightContext, settings, features) : 0)
        + beforeTrajectory;
      const after = radioTransitionScore(leftContext, b, settings, features)
        + radioTransitionScore(b, a, settings, features)
        + (rightContext ? radioTransitionScore(a, rightContext, settings, features) : 0)
        + afterTrajectory;
      if (after > before + 1e-6) [ordered[i], ordered[i + 1]] = [b, a];
    }
  }

  return ordered;
}

/**
 * Reorder only generated/unpinned positions. Prefix locks, pinned tracks,
 * manually inserted tracks, and exact Gradient waypoint tracks remain exactly
 * where they were placed. Existing cached analysis is used immediately; fresh
 * DSP is queued after finalization and affects future generations rather than
 * silently mutating this saved one.
 */
export function resequenceRadioGeneration(
  generationId: string,
  options: { fromPosition?: number } = {},
) {
  const generation = getGeneration(generationId);
  if (!generation) return null;
  const tracks = getGenerationTracks(generationId);
  if (tracks.length <= 1) return tracks;
  const settings = parseRadioSettings(generation.settings_snapshot_json);
  if (settings.djFlow <= 0) return tracks;

  const fromPosition = Math.max(0, options.fromPosition ?? 0);
  const features = new Map(tracks.map((track) => [track.id, loadFeatures(track)]));
  const locked = new Set<number>();
  for (const track of tracks) {
    if (track.position < fromPosition || track.pinned || track.manual || isGradientWaypoint(track)) locked.add(track.position);
  }

  const byPosition = new Map(tracks.map((track) => [track.position, track]));
  const finalOrder: RadioTrackRow[] = [];
  let cursor = 0;
  while (cursor < tracks.length) {
    const current = byPosition.get(cursor)!;
    if (locked.has(cursor)) {
      finalOrder.push(current);
      cursor++;
      continue;
    }

    const start = cursor;
    while (cursor < tracks.length && !locked.has(cursor)) cursor++;
    const segment = tracks.filter((track) => track.position >= start && track.position < cursor);
    const previous = finalOrder.at(-1) ?? null;
    const nextLocked = cursor < tracks.length ? byPosition.get(cursor) ?? null : null;
    finalOrder.push(...segmentOrder(segment, start, tracks.length, previous, nextLocked, settings, features));
  }

  if (finalOrder.every((track, index) => track.id === tracks[index]!.id)) return tracks;

  const db = getDb();
  db.transaction(() => {
    db.query("UPDATE radio_generation_tracks SET position=position+100000 WHERE generation_id=?")
      .run(generationId);
    const stmt = db.query("UPDATE radio_generation_tracks SET position=? WHERE generation_id=? AND id=?");
    finalOrder.forEach((track, index) => stmt.run(index, generationId, track.id));
  })();
  return getGenerationTracks(generationId);
}