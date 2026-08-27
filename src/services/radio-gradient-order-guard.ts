import { getDb } from "../db/database";
import {
  getGeneration,
  getGenerationTracks,
  parseRadioSettings,
  type RadioTrackRow,
} from "../db/repositories/radio";

function metadata(track: RadioTrackRow): Record<string, unknown> {
  try { return track.metadata_json ? JSON.parse(track.metadata_json) as Record<string, unknown> : {}; }
  catch { return {}; }
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

/**
 * Final safety pass after DJ resequencing. It never moves a regenerate prefix,
 * pinned track, or manual edit. Inside each remaining contiguous segment it
 * removes meaningful route-coordinate inversions while preserving unknown
 * coordinate slots. This keeps audio/DJ optimization subordinate to the global
 * A→B musical route instead of allowing BPM/key matching to undo it.
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
  };

  const tracks = getGenerationTracks(generationId);
  if (tracks.length < 2 || !tracks.some((track) => musicalRoutePosition(track) != null)) return {
    applied: false,
    moved: 0,
    backtracksBefore: countGradientRouteBacktracks(tracks),
    backtracksAfter: countGradientRouteBacktracks(tracks),
  };

  const fromPosition = Math.max(0, options.fromPosition ?? 0);
  const locked = new Set<number>();
  for (const track of tracks) {
    if (track.position < fromPosition || track.pinned || track.manual) locked.add(track.position);
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
  return {
    applied: true,
    moved,
    backtracksBefore,
    backtracksAfter: countGradientRouteBacktracks(repaired),
  };
}
