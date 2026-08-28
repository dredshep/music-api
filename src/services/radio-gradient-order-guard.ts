import { getDb } from "../db/database";
import {
  getGeneration,
  getGenerationTracks,
  parseRadioSettings,
  type RadioTrackRow,
} from "../db/repositories/radio";
import { scoreCachedTransitionOrder } from "./radio-transition-order";

function metadata(track: RadioTrackRow): Record<string, unknown> {
  try { return track.metadata_json ? JSON.parse(track.metadata_json) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function isGradientWaypoint(track: RadioTrackRow) {
  return metadata(track).gradientWaypoint === true;
}

export function musicalRoutePosition(track: RadioTrackRow): number | null {
  const meta = metadata(track);
  if (meta.trajectoryCoordinateKind !== "musical_route") return null;
  return track.trajectory_position == null ? null : Math.max(0, Math.min(1, track.trajectory_position));
}

export function countGradientRouteBacktracks(tracks: RadioTrackRow[], tolerance = 0.04): number {
  let count = 0;
  let previous: number | null = null;
  for (const track of tracks) {
    const position = musicalRoutePosition(track);
    if (position == null) continue;
    if (previous != null && position < previous - tolerance) count++;
    previous = position;
  }
  return count;
}

/**
 * Stable repair for one unlocked DJ segment. Unknown-coordinate tracks retain
 * their exact slots. Only tracks carrying a discovered musical-route coordinate
 * are sorted, so DJ flow may still decide where unpositioned material sits.
 */
export function repairGradientRouteSegmentOrder(segment: RadioTrackRow[]): RadioTrackRow[] {
  const routeSlots: number[] = [];
  const routeTracks: RadioTrackRow[] = [];
  segment.forEach((track, index) => {
    if (musicalRoutePosition(track) == null) return;
    routeSlots.push(index);
    routeTracks.push(track);
  });
  if (routeTracks.length < 2) return segment;
  const sorted = [...routeTracks].sort((a, b) => {
    const delta = musicalRoutePosition(a)! - musicalRoutePosition(b)!;
    return Math.abs(delta) > 1e-9 ? delta : a.position - b.position;
  });
  const output = [...segment];
  routeSlots.forEach((slot, index) => { output[slot] = sorted[index]!; });
  return output;
}

function orderTrace(tracks: RadioTrackRow[]) {
  return tracks.map((track) => ({
    canonical_key: track.canonical_key,
    artist: track.artist,
    title: track.title,
    route_position: musicalRoutePosition(track),
  }));
}

/**
 * Final safety pass after DJ resequencing. It never moves a regenerate prefix,
 * pinned track, manual edit, or hard Gradient waypoint. With recording-level
 * coordinates this should normally be a no-op; frequent movement is treated as
 * evidence that an earlier stage is producing an invalid route.
 */
export function enforceGradientRouteOrder(
  generationId: string,
  options: { fromPosition?: number } = {},
) {
  const generation = getGeneration(generationId);
  if (!generation) return null;
  const settings = parseRadioSettings(generation.settings_snapshot_json);
  if (settings.gradientAlgorithm === "blend") return {
    applied: false,
    moved: 0,
    backtracksBefore: 0,
    backtracksAfter: 0,
    orderBefore: [],
    orderAfter: [],
    transitionBefore: null,
    transitionAfter: null,
    transitionScoreDelta: null,
  };

  const tracks = getGenerationTracks(generationId);
  const transitionBefore = scoreCachedTransitionOrder(tracks);
  if (tracks.length < 2 || !tracks.some((track) => musicalRoutePosition(track) != null)) return {
    applied: false,
    moved: 0,
    backtracksBefore: countGradientRouteBacktracks(tracks),
    backtracksAfter: countGradientRouteBacktracks(tracks),
    orderBefore: orderTrace(tracks),
    orderAfter: orderTrace(tracks),
    transitionBefore,
    transitionAfter: transitionBefore,
    transitionScoreDelta: transitionBefore.score == null ? null : 0,
  };

  const fromPosition = Math.max(0, options.fromPosition ?? 0);
  const locked = new Set<number>();
  for (const track of tracks) {
    if (track.position < fromPosition || track.pinned || track.manual || isGradientWaypoint(track)) locked.add(track.position);
  }
  const byPosition = new Map(tracks.map((track) => [track.position, track]));
  const finalOrder: RadioTrackRow[] = [];
  let cursor = 0;
  while (cursor < tracks.length) {
    const current = byPosition.get(cursor)!;
    if (locked.has(cursor)) {
      finalOrder.push(current);
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < tracks.length && !locked.has(cursor)) cursor++;
    const segment = tracks.filter((track) => track.position >= start && track.position < cursor);
    finalOrder.push(...repairGradientRouteSegmentOrder(segment));
  }

  const moved = finalOrder.reduce((count, track, index) => count + (track.id === tracks[index]!.id ? 0 : 1), 0);
  const backtracksBefore = countGradientRouteBacktracks(tracks);
  if (moved) {
    getDb().transaction(() => {
      getDb().query("UPDATE radio_generation_tracks SET position=position+100000 WHERE generation_id=?").run(generationId);
      const stmt = getDb().query("UPDATE radio_generation_tracks SET position=? WHERE generation_id=? AND id=?");
      finalOrder.forEach((track, index) => stmt.run(index, generationId, track.id));
    })();
  }
  const repaired = moved ? getGenerationTracks(generationId) : tracks;
  const transitionAfter = scoreCachedTransitionOrder(repaired);
  const transitionScoreDelta = transitionBefore.score == null || transitionAfter.score == null
    ? null
    : transitionAfter.score - transitionBefore.score;
  return {
    applied: true,
    moved,
    backtracksBefore,
    backtracksAfter: countGradientRouteBacktracks(repaired),
    orderBefore: orderTrace(tracks),
    orderAfter: orderTrace(repaired),
    transitionBefore,
    transitionAfter,
    transitionScoreDelta,
  };
}
