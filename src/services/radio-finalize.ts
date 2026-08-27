import { getDb } from "../db/database";
import { queueRadioGenerationAnalysis } from "./audio-analysis";
import { resequenceRadioGeneration } from "./radio-dj-sequencer";
import { resolveRadioGenerationLocally } from "./radio-local-resolution";
import { presentGeneration } from "./radio";

export function summarizeRadioAvailability(tracks: Array<{ availability: string }>) {
  return {
    selected_count: tracks.length,
    local_count: tracks.filter((track) => track.availability === "local").length,
    spotify_count: tracks.filter((track) => track.availability === "spotify").length,
    unavailable_count: tracks.filter((track) => track.availability === "unavailable").length,
    unknown_count: tracks.filter((track) => track.availability === "unknown").length,
  };
}

/**
 * Final lifecycle pass owned by music-api.
 *
 * New/generated material may be DJ-resequenced using already-cached analysis.
 * Explicit user edits, clones, revision restores and external imports must retain
 * their exact order, so callers can disable resequencing while still receiving
 * final local resolution, fresh diagnostics and background analysis scheduling.
 */
export async function finalizeRadioGeneration(
  generationId: string,
  options: { fromPosition?: number; resequence?: boolean } = {},
) {
  const resolved = await resolveRadioGenerationLocally(generationId);
  if (!resolved) return null;

  const shouldResequence = options.resequence !== false;
  if (shouldResequence) {
    resequenceRadioGeneration(generationId, { fromPosition: options.fromPosition });
  }
  const finalGeneration = presentGeneration(generationId);
  if (!finalGeneration) return null;

  const diagnostics = {
    ...(finalGeneration.diagnostics ?? {}),
    ...summarizeRadioAvailability(finalGeneration.tracks),
    dj_resequenced: shouldResequence,
    ...(shouldResequence ? { dj_resequence_from: Math.max(0, options.fromPosition ?? 0) } : {}),
  };
  getDb().query("UPDATE radio_generations SET diagnostics_json=? WHERE id=?")
    .run(JSON.stringify(diagnostics), generationId);

  queueRadioGenerationAnalysis(generationId);
  return presentGeneration(generationId);
}
