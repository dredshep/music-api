import { getDb } from "../db/database";
import { queueRadioGenerationAnalysis } from "./audio-analysis";
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
 * Every generated or materially edited playlist gets one last Navidrome lookup
 * after selection, then any resolved local files are queued for background DSP
 * analysis. Availability diagnostics are recomputed after that final resolution
 * so the UI never reports stale pre-resolution counts.
 */
export async function finalizeRadioGeneration(generationId: string) {
  const resolved = await resolveRadioGenerationLocally(generationId);
  if (!resolved) return null;

  const diagnostics = {
    ...(resolved.diagnostics ?? {}),
    ...summarizeRadioAvailability(resolved.tracks),
  };
  getDb().query("UPDATE radio_generations SET diagnostics_json=? WHERE id=?")
    .run(JSON.stringify(diagnostics), generationId);

  queueRadioGenerationAnalysis(generationId);
  return presentGeneration(generationId);
}
