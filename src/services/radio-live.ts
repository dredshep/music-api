import { getDb } from "../db/database";
import { finalizeRadioGeneration } from "./radio-finalize";
import { generateStation, presentStation, type TasteTrack } from "./radio";
import { refreshNativeRadioSeedSnapshots } from "./radio-native-seeds";

export type LiveRadioBatchInput = {
  count?: number;
  excludeKeys?: string[];
  tasteProfile?: TasteTrack[];
};

/**
 * Generate a bounded continuation batch without creating a saved Generation.
 *
 * We intentionally reuse the exact saved-generation ranking/finalization path,
 * then delete the temporary generation before returning. This keeps live Radio
 * musically identical to normal Radio while preserving the product invariant
 * that saved generations only appear when the user explicitly creates one.
 */
export async function generateLiveRadioBatch(stationId: string, input: LiveRadioBatchInput = {}) {
  const station = presentStation(stationId);
  if (!station) return null;

  const count = Math.max(4, Math.min(30, Math.floor(input.count ?? 12)));
  const exclude = new Set((input.excludeKeys ?? []).slice(0, 5000));
  // Oversample so the current bounded live queue can be excluded without
  // starving the continuation. The normal generator remains capped at 200.
  const requested = Math.min(200, Math.max(count * 4, count + Math.min(exclude.size, 60)));
  await refreshNativeRadioSeedSnapshots(stationId);

  let temporaryGenerationId: string | null = null;
  try {
    const generated = await generateStation(stationId, {
      length: requested,
      tasteProfile: input.tasteProfile,
    });
    temporaryGenerationId = generated.id;
    const finalized = await finalizeRadioGeneration(generated.id);
    if (!finalized) return null;

    const tracks = finalized.tracks
      .filter((track) => !exclude.has(track.canonical_key))
      .slice(0, count);

    return {
      station_id: stationId,
      mode: "live" as const,
      requested_count: count,
      tracks,
      diagnostics: {
        ...(finalized.diagnostics ?? {}),
        returned_count: tracks.length,
        excluded_count: exclude.size,
        ephemeral: true,
      },
    };
  } finally {
    if (temporaryGenerationId) {
      getDb().query("DELETE FROM radio_generations WHERE id=?").run(temporaryGenerationId);
    }
  }
}
