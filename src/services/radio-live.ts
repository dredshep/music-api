import { getDb } from "../db/database";
import { finalizeRadioGeneration } from "./radio-finalize";
import { presentStation, type TasteTrack } from "./radio";
import { generateRadioStationWithGradient } from "./radio-gradient-generation";
import { selectGradientLiveWindow } from "./radio-live-window";
import { refreshNativeRadioSeedSnapshots } from "./radio-native-seeds";

export type LiveRadioBatchInput = {
  count?: number;
  excludeKeys?: string[];
  tasteProfile?: TasteTrack[];
  routeCursor?: number | null;
};

/**
 * Generate a bounded continuation batch without retaining a saved generation.
 *
 * We intentionally reuse the same standard/Gradient dispatcher and finalizer as
 * saved generations, then delete the temporary generation before returning.
 * Gradient live sessions carry only a normalized musical-route cursor between
 * requests, so every refill can use a fresh ephemeral generation without
 * jumping back to the A side of the route.
 */
export async function generateLiveRadioBatch(stationId: string, input: LiveRadioBatchInput = {}) {
  const station = presentStation(stationId);
  if (!station) return null;

  const count = Math.max(4, Math.min(30, Math.floor(input.count ?? 12)));
  const exclude = new Set((input.excludeKeys ?? []).slice(0, 5000));
  // Oversample so exclusions and route-window positioning do not starve the
  // bounded live queue. The normal generator remains capped at 200.
  const requested = Math.min(200, Math.max(count * 4, count + Math.min(exclude.size, 60)));
  await refreshNativeRadioSeedSnapshots(stationId);

  let temporaryGenerationId: string | null = null;
  try {
    const generated = await generateRadioStationWithGradient(stationId, {
      length: requested,
      tasteProfile: input.tasteProfile,
    });
    temporaryGenerationId = generated.id;
    const finalized = await finalizeRadioGeneration(generated.id, { queueAnalysis: false });
    if (!finalized) return null;

    const liveWindow = station.type === "gradient"
      ? selectGradientLiveWindow(finalized.tracks, {
          count,
          excludeKeys: exclude,
          cursor: input.routeCursor,
        })
      : {
          tracks: finalized.tracks.filter((track) => !exclude.has(track.canonical_key)).slice(0, count),
          routeCursor: null,
          nextCursor: null,
          wrapped: false,
          positionedReturned: 0,
        };

    return {
      station_id: stationId,
      mode: "live" as const,
      requested_count: count,
      route_cursor: liveWindow.routeCursor,
      next_cursor: liveWindow.nextCursor,
      route_wrapped: liveWindow.wrapped,
      tracks: liveWindow.tracks,
      diagnostics: {
        ...(finalized.diagnostics ?? {}),
        returned_count: liveWindow.tracks.length,
        excluded_count: exclude.size,
        live_route_cursor: liveWindow.routeCursor,
        live_next_cursor: liveWindow.nextCursor,
        live_route_wrapped: liveWindow.wrapped,
        live_positioned_returned: liveWindow.positionedReturned,
        ephemeral: true,
      },
    };
  } finally {
    if (temporaryGenerationId) {
      getDb().query("DELETE FROM radio_generations WHERE id=?").run(temporaryGenerationId);
    }
  }
}