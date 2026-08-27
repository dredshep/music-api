export type LiveWindowTrack = {
  canonical_key: string;
  trajectory_position: number | null;
  metadata?: Record<string, unknown> | null;
};

export type LiveWindowResult<T extends LiveWindowTrack> = {
  tracks: T[];
  routeCursor: number | null;
  nextCursor: number | null;
  wrapped: boolean;
  positionedReturned: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function authoritativeRoutePosition(track: LiveWindowTrack): number | null {
  const metadata = track.metadata;
  if (!metadata || metadata.trajectoryCoordinateKind !== "musical_route") return null;
  const value = track.trajectory_position;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : null;
}

/**
 * Select one bounded Live Radio window from a freshly generated Gradient route.
 *
 * The cursor is a normalized musical-route coordinate, not a generation/row id,
 * so the client can remain stateless while each refill may use a new ephemeral
 * generation. Unknown-coordinate fallback tracks retain their local slots once a
 * routed start point has been chosen. Reaching B wraps once to A and reports the
 * next cursor from the wrapped material instead of restarting every refill.
 */
export function selectGradientLiveWindow<T extends LiveWindowTrack>(
  tracks: T[],
  options: { count: number; excludeKeys?: Set<string>; cursor?: number | null },
): LiveWindowResult<T> {
  const count = Math.max(1, Math.floor(options.count));
  const exclude = options.excludeKeys ?? new Set<string>();
  const requestedCursor = clamp01(options.cursor ?? 0);
  const routeIndexes = tracks.flatMap((track, index) => authoritativeRoutePosition(track) == null ? [] : [index]);

  // A failed/legacy route has no authoritative coordinate. Preserve historical
  // Live Radio behavior and explicitly return no cursor to callers.
  if (!routeIndexes.length) {
    return {
      tracks: tracks.filter((track) => !exclude.has(track.canonical_key)).slice(0, count),
      routeCursor: null,
      nextCursor: null,
      wrapped: false,
      positionedReturned: 0,
    };
  }

  let startIndex = routeIndexes.find((index) => authoritativeRoutePosition(tracks[index]!)! >= requestedCursor - 1e-6) ?? -1;
  let wrapped = false;
  if (startIndex < 0) {
    startIndex = routeIndexes[0]!;
    wrapped = true;
  }

  const selected: T[] = [];
  const visited = new Set<number>();
  let index = startIndex;
  let lastRoutePosition: number | null = null;
  let positionedReturned = 0;
  let didWrapDuringFill = wrapped;

  while (selected.length < count && visited.size < tracks.length) {
    if (index >= tracks.length) {
      index = 0;
      didWrapDuringFill = true;
    }
    if (visited.has(index)) break;
    visited.add(index);
    const track = tracks[index]!;
    if (!exclude.has(track.canonical_key)) {
      selected.push(track);
      const routePosition = authoritativeRoutePosition(track);
      if (routePosition != null) {
        lastRoutePosition = routePosition;
        positionedReturned++;
      }
    }
    index++;
  }

  let nextCursor: number;
  if (lastRoutePosition == null) {
    nextCursor = requestedCursor;
  } else if (didWrapDuringFill) {
    // The final routed item came from the next A→B cycle.
    nextCursor = lastRoutePosition >= 0.9995 ? 0 : clamp01(lastRoutePosition + 0.0005);
  } else if (lastRoutePosition >= 0.9995 || index >= tracks.length) {
    nextCursor = 0;
  } else {
    nextCursor = clamp01(lastRoutePosition + 0.0005);
  }

  return {
    tracks: selected,
    routeCursor: requestedCursor,
    nextCursor,
    wrapped: didWrapDuringFill,
    positionedReturned,
  };
}