import type { RadioTrackRow } from "../db/repositories/radio";

function parseMetadata(track: RadioTrackRow): Record<string, unknown> {
  try { return track.metadata_json ? JSON.parse(track.metadata_json) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function musicalRoutePosition(track: RadioTrackRow, metadata = parseMetadata(track)) {
  if (metadata.trajectoryCoordinateKind !== "musical_route") return null;
  return track.trajectory_position == null ? null : Math.max(0, Math.min(1, track.trajectory_position));
}

export function countGradientStageBacktracks(tracks: RadioTrackRow[], tolerance = 0.04) {
  let previous: number | null = null;
  let backtracks = 0;
  for (const track of tracks) {
    const routePosition = musicalRoutePosition(track);
    if (routePosition == null) continue;
    if (previous != null && routePosition < previous - tolerance) backtracks++;
    previous = routePosition;
  }
  return backtracks;
}

export function summarizeGradientStage(tracks: RadioTrackRow[], maxTracks = 250) {
  const positioned = tracks.filter((track) => musicalRoutePosition(track) != null).length;
  const routePositions = tracks
    .map((track) => musicalRoutePosition(track))
    .filter((value): value is number => value != null);
  return {
    count: tracks.length,
    positioned_count: positioned,
    positioned_ratio: tracks.length ? Number((positioned / tracks.length).toFixed(4)) : 0,
    backtracks: countGradientStageBacktracks(tracks),
    first_route_position: routePositions.at(0) ?? null,
    last_route_position: routePositions.at(-1) ?? null,
    truncated: tracks.length > maxTracks,
    tracks: tracks.slice(0, maxTracks).map((track) => {
      const metadata = parseMetadata(track);
      return {
        position: track.position,
        canonical_key: track.canonical_key,
        artist: track.artist,
        title: track.title,
        route_position: musicalRoutePosition(track, metadata),
        trajectory_target: finite(metadata.trajectoryTarget),
        route_artist: typeof metadata.gradientRouteArtist === "string" ? metadata.gradientRouteArtist : null,
        waypoint: metadata.gradientWaypoint === true,
        waypoint_unsupported: metadata.gradientRouteUnsupported === true,
        availability: track.availability_status,
        pinned: Boolean(track.pinned),
        manual: Boolean(track.manual),
      };
    }),
  };
}

export function summarizeGradientCandidateRegions(tracks: Array<{
  routeArtist: string;
  routePosition: number;
}>) {
  const regions = new Map<string, { artist: string; position: number; candidate_count: number }>();
  for (const track of tracks) {
    const position = Math.max(0, Math.min(1, track.routePosition));
    const key = `${track.routeArtist}\u0000${position.toFixed(6)}`;
    const current = regions.get(key);
    if (current) current.candidate_count++;
    else regions.set(key, { artist: track.routeArtist, position, candidate_count: 1 });
  }
  return [...regions.values()].sort((a, b) => a.position - b.position || a.artist.localeCompare(b.artist));
}

export function countMovedTracks(before: RadioTrackRow[], after: RadioTrackRow[]) {
  const beforePosition = new Map(before.map((track) => [track.id, track.position]));
  return after.reduce((count, track) => count + (beforePosition.get(track.id) === track.position ? 0 : 1), 0);
}

export function countResolutionChanges(before: RadioTrackRow[], after: RadioTrackRow[]) {
  const prior = new Map(before.map((track) => [track.id, `${track.playback_source ?? ""}|${track.availability_status}|${track.navidrome_id ?? ""}`]));
  return after.reduce((count, track) => {
    const current = `${track.playback_source ?? ""}|${track.availability_status}|${track.navidrome_id ?? ""}`;
    return count + (prior.get(track.id) === current ? 0 : 1);
  }, 0);
}
