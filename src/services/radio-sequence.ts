import { createHash } from "node:crypto";
import { normalizeForComparison } from "../domain/normalization";
import type { RadioSettings, RadioStationType } from "../db/repositories/radio";
import { radioArtistCooldownKey } from "./radio-artist-credit";

export type RadioSequenceCandidate = {
  key: string;
  artist: string;
  title: string;
  album: string | null;
  selectionScore: number;
  seedScores: Record<string, number>;
  metadata: Record<string, unknown>;
};

export type RadioSequenceSeed = {
  id: string;
  artist: string | null;
  position: number | null;
  weight?: number;
};

function seededUnit(seed: string, key: string): number {
  const hex = createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16) / 0x1fffffffffffff;
}

function targetSeedWeights(seeds: RadioSequenceSeed[], t: number): Record<string, number> {
  if (seeds.length === 1) return { [seeds[0]!.id]: 1 };
  const positions = seeds.map((seed, index) => ({
    id: seed.id,
    pos: seed.position == null ? index / Math.max(1, seeds.length - 1) : Math.min(1, Math.max(0, seed.position)),
    weight: seed.weight ?? 1,
  }));
  const values: Record<string, number> = {};
  let total = 0;
  for (const row of positions) {
    const value = row.weight / Math.max(0.08, Math.abs(t - row.pos) + 0.08);
    values[row.id] = value;
    total += value;
  }
  for (const key of Object.keys(values)) values[key] = values[key]! / Math.max(0.0001, total);
  return values;
}

/** Coarse selection-time flow; final DJ ordering uses the richer cached-feature sequencer. */
export function radioTransitionScoreLite(
  a: RadioSequenceCandidate | null,
  b: RadioSequenceCandidate,
  settings: RadioSettings,
): number {
  if (!a) return 0;
  let score = 0;
  const sameArtist = radioArtistCooldownKey(a.artist) === radioArtistCooldownKey(b.artist);
  if (sameArtist) score -= settings.repeatStrength * (1.25 + (settings.djWeights.artistSpacing ?? 0));
  if (a.album && b.album && normalizeForComparison(a.album) === normalizeForComparison(b.album)) score -= 0.35;

  const aMeta = a.metadata as { bpm?: number; energy?: number; key?: string; loudness?: number };
  const bMeta = b.metadata as { bpm?: number; energy?: number; key?: string; loudness?: number };
  if (aMeta.bpm && bMeta.bpm) score += Math.max(0, 1 - Math.abs(aMeta.bpm - bMeta.bpm) / 60) * (settings.djWeights.tempo ?? 0);
  if (aMeta.energy != null && bMeta.energy != null) score += Math.max(0, 1 - Math.abs(aMeta.energy - bMeta.energy)) * (settings.djWeights.energy ?? 0);
  if (aMeta.key && bMeta.key) score += (aMeta.key === bMeta.key ? 1 : 0) * (settings.djWeights.key ?? 0);
  if (aMeta.loudness != null && bMeta.loudness != null) {
    score += Math.max(0, 1 - Math.abs(aMeta.loudness - bMeta.loudness) / 12) * (settings.djWeights.timbre ?? 0) * 0.5;
  }
  return score * settings.djFlow;
}

export function artistWithinCooldown(
  artistKey: string,
  position: number,
  artistLast: Map<string, number>,
  cooldown: number,
): boolean {
  if (cooldown <= 0 || !artistKey) return false;
  const last = artistLast.get(artistKey);
  return last != null && position - last <= cooldown;
}

/**
 * Greedy sequence builder. `artistCooldown` is a hard skip while alternatives
 * remain; soft residual penalty still ranks near-cooldown candidates when the
 * pool is exhausted.
 */
export function selectRadioSequence<T extends RadioSequenceCandidate>(
  scored: T[],
  length: number,
  settings: RadioSettings,
  seeds: RadioSequenceSeed[],
  stationType: RadioStationType,
  randomSeed: string,
): T[] {
  const selected: T[] = [];
  const used = new Set<string>();
  const artistLast = new Map<string, number>();
  const seedArtists = new Set(
    seeds.map((seed) => radioArtistCooldownKey(seed.artist ?? "")).filter(Boolean),
  );
  let seedArtistCount = 0;
  const pool = scored.slice(0, Math.max(scored.length, 120, length * 8));

  for (let position = 0; position < length && used.size < scored.length; position++) {
    const t = length <= 1 ? 0 : position / (length - 1);
    const targets = stationType === "gradient" ? targetSeedWeights(seeds, t) : null;

    const pick = (allowCooldownViolation: boolean) => {
      let best: T | null = null;
      let bestScore = -Infinity;

      for (const candidate of pool) {
        if (used.has(candidate.key)) continue;
        const artistKey = radioArtistCooldownKey(candidate.artist);
        const onCooldown = artistWithinCooldown(artistKey, position, artistLast, settings.artistCooldown);
        if (onCooldown && !allowCooldownViolation) continue;

        const last = artistLast.get(artistKey);
        const gap = last == null ? Number.POSITIVE_INFINITY : position - last;
        let repeatPenalty = 0;
        if (last != null) {
          repeatPenalty = Math.max(0, (settings.artistCooldown - gap + 1) / Math.max(1, settings.artistCooldown))
            * settings.repeatStrength;
        }

        const trajectory = targets
          ? Object.entries(targets).reduce((sum, [seedId, weight]) => sum + (candidate.seedScores[seedId] ?? 0) * weight, 0) * 2
          : 0;
        const previous = selected.at(-1) ?? null;
        const flow = radioTransitionScoreLite(previous, candidate, settings);
        const isSeedArtist = seedArtists.has(artistKey);
        const currentRatio = position === 0 ? 0 : seedArtistCount / position;
        const frequencyAdjustment = isSeedArtist
          ? (settings.seedArtistFrequency - currentRatio) * 0.75
          : Math.max(0, currentRatio - settings.seedArtistFrequency) * 0.25;
        const jitter = seededUnit(randomSeed, `${position}:${candidate.key}`) * 0.025;

        // When every remaining artist is still cooling down, maximize gap first so
        // album-seed affinity cannot keep dumping the same band back-to-back.
        const score = allowCooldownViolation
          ? (Number.isFinite(gap) ? gap : 1000) * 100
            + flow * 2
            + frequencyAdjustment
            + candidate.selectionScore * 0.05
            + jitter
            - repeatPenalty
          : candidate.selectionScore + trajectory + flow - repeatPenalty + frequencyAdjustment + jitter;

        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      return best ? { candidate: best, score: bestScore } : null;
    };

    const chosen = pick(false) ?? pick(true);
    if (!chosen) break;

    const artistKey = radioArtistCooldownKey(chosen.candidate.artist);
    used.add(chosen.candidate.key);
    if (artistKey) artistLast.set(artistKey, position);
    if (seedArtists.has(artistKey)) seedArtistCount++;
    selected.push({
      ...chosen.candidate,
      selectionScore: chosen.score,
      metadata: { ...chosen.candidate.metadata, trajectoryTarget: stationType === "gradient" ? t : null },
    });
  }

  return selected;
}
