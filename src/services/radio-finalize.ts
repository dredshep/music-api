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
 * Final generation lifecycle pass owned by music-api.
 *
 * First resolve final local playback, then improve ordering using any audio
 * analysis already cached for these tracks. Fresh DSP is queued only after the
 * saved order is fixed, so analysis never silently mutates an old generation.
 */
export async function finalizeRadioGeneration(
  generationId: string,
  options: { fromPosition?: number } = {},
) {
  const resolved = await resolveRadioGenerationLocally(generationId);
  if (!resolved) return null;

  resequenceRadioGeneration(generationId, options);
  const finalGeneration = presentGeneration(generationId);
  if (!finalGeneration) return null;

  const diagnostics = {
    ...(finalGeneration.diagnostics ?? {}),
    ...summarizeRadioAvailability(finalGeneration.tracks),
    dj_resequenced: true,
    dj_resequence_from: Math.max(0, options.fromPosition ?? 0),
  };
  getDb().query("UPDATE radio_generations SET diagnostics_json=? WHERE id=?")
    .run(JSON.stringify(diagnostics), generationId);

  queueRadioGenerationAnalysis(generationId);
  return presentGeneration(generationId);
}
