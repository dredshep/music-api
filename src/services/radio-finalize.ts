import { getDb } from "../db/database";
import { queueRadioGenerationAnalysis } from "./audio-analysis";
import { resequenceRadioGeneration } from "./radio-dj-sequencer";
import { enforceGradientRouteOrder } from "./radio-gradient-order-guard";
import { enforceExplicitGradientTrackWaypoints } from "./radio-gradient-waypoint-guard";
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
 * their exact order. Ephemeral callers may also suppress background analysis so
 * no jobs are queued against a generation that is about to be deleted.
 */
export async function finalizeRadioGeneration(
  generationId: string,
  options: { fromPosition?: number; resequence?: boolean; queueAnalysis?: boolean } = {},
) {
  const shouldResequence = options.resequence !== false;
  const gradientWaypointGuard = shouldResequence
    ? enforceExplicitGradientTrackWaypoints(generationId, { fromPosition: options.fromPosition })
    : null;

  // Resolve after waypoint enforcement so an exact track waypoint inserted by
  // the guard receives the same Navidrome/local playback resolution as every
  // other generated candidate.
  const resolved = await resolveRadioGenerationLocally(generationId);
  if (!resolved) return null;

  let gradientRouteOrderGuard: ReturnType<typeof enforceGradientRouteOrder> = null;
  if (shouldResequence) {
    resequenceRadioGeneration(generationId, { fromPosition: options.fromPosition });
    // Audio compatibility is a local optimization. A discovered musical route
    // is the global constraint, so repair any meaningful route inversions the
    // DJ pass introduced before persisting the exact saved playlist order.
    gradientRouteOrderGuard = enforceGradientRouteOrder(generationId, { fromPosition: options.fromPosition });
  }
  const finalGeneration = presentGeneration(generationId);
  if (!finalGeneration) return null;

  const diagnostics = {
    ...(finalGeneration.diagnostics ?? {}),
    ...summarizeRadioAvailability(finalGeneration.tracks),
    dj_resequenced: shouldResequence,
    ...(shouldResequence ? { dj_resequence_from: Math.max(0, options.fromPosition ?? 0) } : {}),
    ...(gradientWaypointGuard ? { gradient_track_waypoint_guard: gradientWaypointGuard } : {}),
    ...(gradientRouteOrderGuard ? { gradient_route_order_guard: gradientRouteOrderGuard } : {}),
  };
  getDb().query("UPDATE radio_generations SET diagnostics_json=? WHERE id=?")
    .run(JSON.stringify(diagnostics), generationId);

  if (options.queueAnalysis !== false) queueRadioGenerationAnalysis(generationId);
  return presentGeneration(generationId);
}
