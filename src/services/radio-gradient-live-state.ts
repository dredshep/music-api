export type GradientLivePresentedTrack = {
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
  tracks: GradientLivePresentedTrack[];
  next_index: number;
  previous_key: string | null;
  completed: boolean;
  route_complete: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function authoritativeGradientLiveRoutePosition(track: GradientLivePresentedTrack) {
  const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
  return metadata.trajectoryCoordinateKind === "musical_route" && typeof track.trajectory_position === "number"
    ? clamp(track.trajectory_position, 0, 1)
    : null;
}

export function isValidGradientLiveRouteState(
  stationId: string,
  state: LiveGradientRouteState | null | undefined,
): state is LiveGradientRouteState {
  if (!state || state.version !== 1 || state.station_id !== stationId || !Array.isArray(state.tracks)) return false;
  if (state.tracks.length > 200 || !Number.isInteger(state.next_index) || state.next_index < 0) return false;
  if (state.next_index > state.tracks.length) return false;
  if (state.next_index >= state.tracks.length && !state.completed) return false;
  return true;
}

export function consumeGradientLiveRouteState(
  state: LiveGradientRouteState,
  count: number,
  exclude: Set<string>,
) {
  const tracks: GradientLivePresentedTrack[] = [];
  let cursor = Math.min(state.next_index, state.tracks.length);
  while (cursor < state.tracks.length && tracks.length < count) {
    const track = state.tracks[cursor++]!;
    if (exclude.has(track.canonical_key)) continue;
    tracks.push(track);
  }
  const previousKey = tracks.at(-1)?.canonical_key ?? state.previous_key;
  const arrayExhausted = cursor >= state.tracks.length;
  const completed = arrayExhausted && state.route_complete;
  const nextState: LiveGradientRouteState = {
    ...state,
    next_index: cursor,
    previous_key: previousKey,
    completed,
  };
  const positions = tracks.flatMap((track) => {
    const value = authoritativeGradientLiveRoutePosition(track);
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

export function createGradientLiveRouteState(stationId: string, generation: {
  generator_version: string;
  diagnostics?: Record<string, unknown> | null;
  tracks: GradientLivePresentedTrack[];
}) {
  const route = generation.diagnostics?.gradient_route;
  const routeObject = route && typeof route === "object" && !Array.isArray(route) ? route as Record<string, unknown> : null;
  const isRecordingPath = routeObject?.model === "recording_path_v1" && routeObject?.usable === true;
  const fallback = generation.diagnostics?.gradient_fallback_radio === true;
  const positioned = generation.tracks.filter((track) => authoritativeGradientLiveRoutePosition(track) != null);
  if (!isRecordingPath || fallback || positioned.length < 2) return null;

  const finalEp = generation.diagnostics?.gradient_final_endpoint_status as Record<string, unknown> | null | undefined;
  const plannerEp = routeObject?.endpoint_status as Record<string, unknown> | null | undefined;
  const endpointStatus = finalEp ?? plannerEp;
  const routeComplete = routeObject?.complete === true
    && endpointStatus?.start_satisfied === true
    && endpointStatus?.end_satisfied === true;

  if (!routeComplete) return null;

  return {
    version: 1 as const,
    station_id: stationId,
    generator_version: generation.generator_version,
    tracks: generation.tracks.slice(0, 200),
    next_index: 0,
    previous_key: null,
    completed: false,
    route_complete: true,
  } satisfies LiveGradientRouteState;
}
