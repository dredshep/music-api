import { getDb } from "../db/database";
import { finalizeRadioGeneration } from "./radio-finalize";
import { presentStation, type TasteTrack } from "./radio";
import { generateRadioStationWithGradient } from "./radio-gradient-generation";
import {
  consumeGradientLiveRouteState,
  createGradientLiveRouteState,
  isValidGradientLiveRouteState,
  type GradientLivePresentedTrack,
  type LiveGradientRouteState,
} from "./radio-gradient-live-state";
import { selectGradientLiveWindow } from "./radio-live-window";
import { refreshNativeRadioSeedSnapshots } from "./radio-native-seeds";

export type { LiveGradientRouteState } from "./radio-gradient-live-state";

export type LiveRadioBatchInput = {
  count?: number;
  excludeKeys?: string[];
  tasteProfile?: TasteTrack[];
  routeCursor?: number | null;
  routeState?: LiveGradientRouteState | null;
};

/**
 * Generate or continue a bounded live queue. Recording-level Gradient sessions
 * keep the finalized planned path in client-carried state, so refills consume
 * one coherent route instead of independently rediscovering a path every time.
 */
export async function generateLiveRadioBatch(stationId: string, input: LiveRadioBatchInput = {}) {
  const station = presentStation(stationId);
  if (!station) return null;

  const count = Math.max(4, Math.min(30, Math.floor(input.count ?? 12)));
  const exclude = new Set((input.excludeKeys ?? []).slice(0, 5000));
  if (station.type === "gradient" && isValidGradientLiveRouteState(stationId, input.routeState)) {
    const continuation = consumeGradientLiveRouteState(input.routeState, count, exclude);
    return {
      station_id: stationId,
      mode: "live" as const,
      requested_count: count,
      route_cursor: continuation.routeCursor,
      next_cursor: continuation.nextCursor,
      route_wrapped: false,
      route_completed: continuation.completed,
      route_state: continuation.state,
      tracks: continuation.tracks,
      diagnostics: {
        returned_count: continuation.tracks.length,
        excluded_count: exclude.size,
        live_route_cursor: continuation.routeCursor,
        live_next_cursor: continuation.nextCursor,
        live_route_wrapped: false,
        live_route_completed: continuation.completed,
        live_route_state_reused: true,
        live_previous_recording_key: input.routeState.previous_key,
        ephemeral: true,
      },
    };
  }

  // First recording-path batch intentionally plans farther ahead than the
  // immediate queue. The client then carries and consumes that exact path.
  const requested = station.type === "gradient"
    ? Math.min(120, Math.max(station.settings.length, count * 5, 30))
    : Math.min(200, Math.max(count * 4, count + Math.min(exclude.size, 60)));
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

    const recordingState = station.type === "gradient"
      ? createGradientLiveRouteState(stationId, finalized as typeof finalized & { tracks: GradientLivePresentedTrack[] })
      : null;
    if (recordingState) {
      const first = consumeGradientLiveRouteState(recordingState, count, exclude);
      return {
        station_id: stationId,
        mode: "live" as const,
        requested_count: count,
        route_cursor: first.routeCursor,
        next_cursor: first.nextCursor,
        route_wrapped: false,
        route_completed: first.completed,
        route_state: first.state,
        tracks: first.tracks,
        diagnostics: {
          ...(finalized.diagnostics ?? {}),
          returned_count: first.tracks.length,
          excluded_count: exclude.size,
          live_route_cursor: first.routeCursor,
          live_next_cursor: first.nextCursor,
          live_route_wrapped: false,
          live_route_completed: first.completed,
          live_route_state_reused: false,
          live_route_planned_count: recordingState.tracks.length,
          ephemeral: true,
        },
      };
    }

    // Backward-compatible windowing remains for standard Radio, legacy Blend,
    // partial/no-route generations and old saved semantics.
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
      route_completed: false,
      route_state: null,
      tracks: liveWindow.tracks,
      diagnostics: {
        ...(finalized.diagnostics ?? {}),
        returned_count: liveWindow.tracks.length,
        excluded_count: exclude.size,
        live_route_cursor: liveWindow.routeCursor,
        live_next_cursor: liveWindow.nextCursor,
        live_route_wrapped: liveWindow.wrapped,
        live_positioned_returned: liveWindow.positionedReturned,
        live_route_state_reused: false,
        ephemeral: true,
      },
    };
  } finally {
    if (temporaryGenerationId) {
      getDb().query("DELETE FROM radio_generations WHERE id=?").run(temporaryGenerationId);
    }
  }
}
