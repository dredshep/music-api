import { getDb } from "../db/database";
import { canonicalRadioTrackKey } from "./radio";

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

export interface CachedAcousticFeatures {
  bpm?: number;
  key?: string;
  mode?: string;
  loudness?: number;
  energy?: number;
  timbre?: Record<string, number>;
  intro?: Record<string, number>;
  outro?: Record<string, number>;
}

export interface AcousticTransitionAssessment {
  evidenceCount: number;
  score: number | null;
  catastrophic: boolean;
  reasons: string[];
  metrics: {
    tempo: number | null;
    key: number | null;
    energy: number | null;
    timbre: number | null;
    introOutro: number | null;
    loudness: number | null;
  };
}

const KEY_INDEX: Record<string, number> = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4,
  F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11,
};

function parseObject(raw: string | null): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const output: Record<string, number> = {};
    for (const [key, item] of Object.entries(value)) if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    return Object.keys(output).length ? output : undefined;
  } catch {
    return undefined;
  }
}

export function loadCachedAcousticFeatures(canonicalKey: string): CachedAcousticFeatures | null {
  const row = getDb().query<AnalysisRow, [string]>(`SELECT bpm,musical_key,mode,loudness,energy,timbre_json,intro_json,outro_json
      FROM track_audio_analysis
      WHERE canonical_key=? AND status='ready'
      ORDER BY analysis_version DESC LIMIT 1`).get(canonicalKey);
  if (!row) return null;
  return {
    bpm: row.bpm ?? undefined,
    key: row.musical_key ?? undefined,
    mode: row.mode ?? undefined,
    loudness: row.loudness ?? undefined,
    energy: row.energy ?? undefined,
    timbre: parseObject(row.timbre_json),
    intro: parseObject(row.intro_json),
    outro: parseObject(row.outro_json),
  };
}

function tempoSimilarity(a?: number, b?: number): number | null {
  if (!a || !b) return null;
  const diff = Math.min(Math.abs(a - b), Math.abs(a * 2 - b), Math.abs(a - b * 2));
  return Math.max(0, 1 - diff / 45);
}

function keySimilarity(a: CachedAcousticFeatures, b: CachedAcousticFeatures): number | null {
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
  if ([1, 2, 10, 11].includes(delta)) return 0.42;
  return 0.25;
}

function scalarSimilarity(a: number | undefined, b: number | undefined, range = 1): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, 1 - Math.abs(a - b) / range);
}

function timbreSimilarity(a?: Record<string, number>, b?: Record<string, number>): number | null {
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

function introOutroSimilarity(outro?: Record<string, number>, intro?: Record<string, number>): number | null {
  if (!outro || !intro) return null;
  if (outro.dbfs != null && intro.dbfs != null) return Math.max(0, 1 - Math.abs(outro.dbfs - intro.dbfs) / 24);
  if (outro.rms != null && intro.rms != null) return Math.max(0, 1 - Math.abs(outro.rms - intro.rms) / 0.35);
  return null;
}

export function assessAcousticTransition(a: CachedAcousticFeatures | null, b: CachedAcousticFeatures | null): AcousticTransitionAssessment {
  if (!a || !b) {
    return {
      evidenceCount: 0,
      score: null,
      catastrophic: false,
      reasons: [],
      metrics: { tempo: null, key: null, energy: null, timbre: null, introOutro: null, loudness: null },
    };
  }
  const metrics = {
    tempo: tempoSimilarity(a.bpm, b.bpm),
    key: keySimilarity(a, b),
    energy: scalarSimilarity(a.energy, b.energy, 1),
    timbre: timbreSimilarity(a.timbre, b.timbre),
    introOutro: introOutroSimilarity(a.outro, b.intro),
    loudness: scalarSimilarity(a.loudness, b.loudness, 24),
  };
  // Key disagreement is useful for DJ ranking but not a genre/acoustic cliff by
  // itself. Catastrophic gating is based on broader sound/energy/hand-off data.
  const cliffValues = [metrics.tempo, metrics.energy, metrics.timbre, metrics.introOutro, metrics.loudness]
    .filter((value): value is number => value != null);
  const evidenceCount = cliffValues.length;
  const mean = evidenceCount ? cliffValues.reduce((sum, value) => sum + value, 0) / evidenceCount : null;
  const veryLow = cliffValues.filter((value) => value <= 0.12).length;
  const reasons: string[] = [];
  const multiDimensionCliff = evidenceCount >= 4 && mean != null && mean < 0.2 && veryLow >= 2;
  const timbreEnergyCliff = metrics.timbre != null && metrics.energy != null
    && metrics.timbre <= 0.1 && metrics.energy <= 0.14
    && ((metrics.tempo != null && metrics.tempo <= 0.16) || (metrics.introOutro != null && metrics.introOutro <= 0.16));
  if (multiDimensionCliff) reasons.push("multi_dimension_acoustic_cliff");
  if (timbreEnergyCliff) reasons.push("timbre_energy_cliff");
  return {
    evidenceCount,
    score: mean,
    catastrophic: reasons.length > 0,
    reasons,
    metrics,
  };
}

export function assessCachedAcousticTransition(
  from: { artist: string; title: string },
  to: { artist: string; title: string },
) {
  const a = loadCachedAcousticFeatures(canonicalRadioTrackKey(from.artist, from.title));
  const b = loadCachedAcousticFeatures(canonicalRadioTrackKey(to.artist, to.title));
  return assessAcousticTransition(a, b);
}
