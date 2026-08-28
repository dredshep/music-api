import { getDb } from "../db/database";
import { finalizeRadioGeneration } from "./radio-finalize";
import { presentStation, type TasteTrack } from "./radio";
import { generateRadioStationWithGradient } from "./radio-gradient-generation";
import { selectGradientLiveWindow } from "./radio-live-window";
import { refreshNativeRadioSeedSnapshots } from "./radio-native-seeds";

type PresentedTrack = {
  id: string;
  position: number;
  canonical_key: string;
  artist: string;
  title: string;
  album: string | null;
  duration_ms: number | null;
  isrc: string | null;
  spotify_id: string | null;
  navidrome_id: string | null;
  musicbrainz_id: string | null;
  playback_source: string | null;
  availability: string;
  pinned: boolean;
  manual: boolean;
  score: number;
  trajectory_position: number | null;
  metadata: Record<string, unknown> | null;
};

export type LiveGradientRouteState = {
  version: 1;
  station_id: string;
  generator_version: string;
  tracks: PresentedTrack[];
  next_index: number;
  previous_key: string | null;
  completed: boolean;
};

export type LiveRadioBatchInput = {
  count?: number;
  excludeKeys?: string[];
  tasteProfile?: TasteTrack[];
  routeCursor?: number | null;
  routeState?: LiveGradientRouteState | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function authoritativeRoutePosition(track: PresentedTrack) {
  const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
  return metadata.trajectoryCoordinateKind === "musical_route" && typeof track.trajectory_position === "number"
    ? clamp(track.trajectory_position, 0, 1)
    : null;
}

function validRouteState(stationId: string, state: LiveGradientRouteState | null | undefined): state is LiveGradientRouteState {
  return Boolean(
    state && state.version === 1 && state.station_id === stationId && Array.isArray(state.tracks)
      && state.tracks.length <= 200 && Number.isInteger(state.next_index) && state.next_index >= 0,
  );
}

function consumeRouteState(
  state: LiveGradientRouteState,
  count: number,
  exclude: Set<string>,
) {
  const tracks: PresentedTrack[] = [];
  let cursor = Math.min(state.next_index, state.tracks.length);
  while (cursor < state.tracks.length && tracks.length < count) {
    const track = state.tracks[cursor++]!;
    if (exclude.has(track.canonical_key)) continue;
    tracks.push(track);
  }
  const previousKey = tracks.at(-1)?.canonical_key ?? state.previous_key;
  const completed = cursor >= state.tracks.length;
  const nextState: LiveGradientRouteState = {
    ...state,
    next_index: cursor,
    previous_key: previousKey,
    completed,
  };
  const positions = tracks.flatMap((track) => {
    const value = authoritativeRoutePosition(track);
    return value == null ? [] : [value];
  });
  return {
    tracks,
    routeCursor: positions[0] ?? null,
    nextCursor: positions.at(-1) ?? (completed ? 1 : null),
    completed,
    state: nextState,
  };
}

function routeStateFromGeneration(stationId: string, generation: {
  generator_version: string;
  diagnostics?: Record<string, unknown> | null;
  tracks: PresentedTrack[];
}) {
  const route = generation.diagnostics?.gradient_route;
  const routeObject = route && typeof route === "object" && !Array.isArray(route) ? route as Record<string, unknown> : null;
  const isRecordingPath = routeObject?.model === "recording_path_v1" && routeObject?.usable === true;
  const fallback = generation.diagnostics?.gradient_fallback_radio === true;
  const positioned = generation.tracks.filter((track) => authoritativeRoutePosition(track) != null);
  if (!isRecordingPath || fallback || positioned.length < 2) return null;
  return {
    version: 1 as const,
    station_id: stationId,
    generator_version: generation.generator_version,
    tracks: generation.tracks.slice(0, 200),
    next_index: 0,
    previous_key: null,
    completed: false,
  } satisfies LiveGradientRouteState;
}

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
  if (station.type === "gradient" && validRouteState(stationId, input.routeState)) {
    const continuation = consumeRouteState(input.routeState, count, exclude);
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
      ? routeStateFromGeneration(stationId, finalized as typeof finalized & { tracks: PresentedTrack[] })
      : null;
    if (recordingState) {
      const first = consumeRouteState(recordingState, count, exclude);
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
