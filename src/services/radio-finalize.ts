import { getDb } from "../db/database";
import { getGenerationTracks } from "../db/repositories/radio";
import { queueRadioGenerationAnalysis } from "./audio-analysis";
import { resequenceRadioGeneration } from "./radio-dj-sequencer";
import {
  countMovedTracks,
  countResolutionChanges,
  summarizeGradientStage,
} from "./radio-gradient-observability";
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function elapsedMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(2));
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
  const finalizeStartedAt = performance.now();
  const shouldResequence = options.resequence !== false;
  const beforeWaypointTracks = getGenerationTracks(generationId);

  const waypointStartedAt = performance.now();
  const gradientWaypointGuard = shouldResequence
    ? enforceExplicitGradientTrackWaypoints(generationId, { fromPosition: options.fromPosition })
    : null;
  const waypointMs = elapsedMs(waypointStartedAt);
  const afterWaypointTracks = getGenerationTracks(generationId);

  // Resolve after waypoint enforcement so an exact track waypoint inserted by
  // the guard receives the same Navidrome/local playback resolution as every
  // other generated candidate.
  const resolutionStartedAt = performance.now();
  const resolved = await resolveRadioGenerationLocally(generationId);
  const localResolutionMs = elapsedMs(resolutionStartedAt);
  if (!resolved) return null;
  const afterResolutionTracks = getGenerationTracks(generationId);

  let gradientRouteOrderGuard: ReturnType<typeof enforceGradientRouteOrder> = null;
  let djResequenceMs = 0;
  let routeOrderGuardMs = 0;
  let afterDjTracks = afterResolutionTracks;
  if (shouldResequence) {
    const djStartedAt = performance.now();
    resequenceRadioGeneration(generationId, { fromPosition: options.fromPosition });
    djResequenceMs = elapsedMs(djStartedAt);
    afterDjTracks = getGenerationTracks(generationId);

    // Audio compatibility is a local optimization. A discovered musical route
    // is the global constraint, so repair any meaningful route inversions the
    // DJ pass introduced before persisting the exact saved playlist order.
    const guardStartedAt = performance.now();
    gradientRouteOrderGuard = enforceGradientRouteOrder(generationId, { fromPosition: options.fromPosition });
    routeOrderGuardMs = elapsedMs(guardStartedAt);
  }
  const finalTracks = getGenerationTracks(generationId);
  const finalGeneration = presentGeneration(generationId);
  if (!finalGeneration) return null;

  const existingDiagnostics = object(finalGeneration.diagnostics);
  const priorTiming = object(existingDiagnostics.gradient_pipeline_timing);
  const isGradientRouteGeneration = Boolean(existingDiagnostics.gradient_route);
  const finalizeTotalMs = elapsedMs(finalizeStartedAt);
  const generationWithGradientMs = finite(priorTiming.generation_with_gradient_ms);

  const diagnostics = {
    ...existingDiagnostics,
    ...summarizeRadioAvailability(finalGeneration.tracks),
    dj_resequenced: shouldResequence,
    ...(shouldResequence ? {
      dj_resequence_from: Math.max(0, options.fromPosition ?? 0),
      dj_moved_count: countMovedTracks(afterResolutionTracks, afterDjTracks),
    } : {}),
    local_resolution_changed_count: countResolutionChanges(afterWaypointTracks, afterResolutionTracks),
    ...(gradientWaypointGuard ? { gradient_track_waypoint_guard: gradientWaypointGuard } : {}),
    ...(gradientRouteOrderGuard ? { gradient_route_order_guard: gradientRouteOrderGuard } : {}),
    ...(isGradientRouteGeneration ? {
      gradient_stage_before_waypoints: summarizeGradientStage(beforeWaypointTracks),
      gradient_stage_after_waypoints: summarizeGradientStage(afterWaypointTracks),
      gradient_stage_after_resolution: summarizeGradientStage(afterResolutionTracks),
      gradient_stage_after_dj: summarizeGradientStage(afterDjTracks),
      gradient_stage_final: summarizeGradientStage(finalTracks),
      gradient_pipeline_timing: {
        ...priorTiming,
        waypoint_guard_ms: waypointMs,
        local_resolution_ms: localResolutionMs,
        dj_resequence_ms: djResequenceMs,
        route_order_guard_ms: routeOrderGuardMs,
        finalize_total_ms: finalizeTotalMs,
        ...(generationWithGradientMs != null ? {
          total_until_finalized_ms: Number((generationWithGradientMs + finalizeTotalMs).toFixed(2)),
        } : {}),
      },
    } : {}),
  };
  getDb().query("UPDATE radio_generations SET diagnostics_json=? WHERE id=?")
    .run(JSON.stringify(diagnostics), generationId);

  if (options.queueAnalysis !== false) queueRadioGenerationAnalysis(generationId);
  return presentGeneration(generationId);
}
