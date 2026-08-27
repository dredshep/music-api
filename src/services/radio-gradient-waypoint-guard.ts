import {
  getGeneration,
  getGenerationTracks,
  getSeeds,
  replaceGenerationTracks,
  type RadioTrackRow,
} from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";
import { canonicalRadioTrackKey } from "./radio";

function parseObject(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

type RouteSupport = {
  intervals: Array<{ from: number; to: number }> | null;
};

function routeSupport(raw: string | null): RouteSupport | null {
  const diagnostics = parseObject(raw);
  const route = diagnostics.gradient_route;
  if (!route || typeof route !== "object" || Array.isArray(route)) return null;
  const routeRow = route as Record<string, unknown>;
  if (routeRow.usable !== true) return null;
  // Older stored generations may predate per-leg diagnostics. In that case the
  // old all-or-nothing usable flag is the only information available.
  if (!Array.isArray(routeRow.segments)) return { intervals: null };
  const intervals = routeRow.segments.flatMap((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) return [];
    const row = segment as Record<string, unknown>;
    if (row.connected !== true || typeof row.from_position !== "number" || typeof row.to_position !== "number") return [];
    return [{ from: Math.min(row.from_position, row.to_position), to: Math.max(row.from_position, row.to_position) }];
  });
  return { intervals };
}

function supportsPosition(support: RouteSupport, position: number) {
  return support.intervals == null || support.intervals.some((interval) =>
    position >= interval.from - 1e-6 && position <= interval.to + 1e-6
  );
}

function copy(track: RadioTrackRow) {
  return {
    canonical_key: track.canonical_key,
    artist: track.artist,
    title: track.title,
    album: track.album,
    duration_ms: track.duration_ms,
    isrc: track.isrc,
    spotify_id: track.spotify_id,
    navidrome_id: track.navidrome_id,
    musicbrainz_id: track.musicbrainz_id,
    playback_source: track.playback_source,
    availability_status: track.availability_status,
    pinned: track.pinned,
    manual: track.manual,
    selection_score: track.selection_score,
    trajectory_position: track.trajectory_position,
    metadata_json: track.metadata_json,
  };
}

type StoredCopy = ReturnType<typeof copy>;

function isProtected(track: StoredCopy, index: number, lockedPrefix: number) {
  return index < lockedPrefix || Boolean(track.pinned) || Boolean(track.manual);
}

function nearestReplaceableIndex(
  output: StoredCopy[],
  desiredIndex: number,
  lockedPrefix: number,
  waypointKeys: Set<string>,
  allowKey?: string,
) {
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < output.length; index++) {
    const track = output[index]!;
    if (isProtected(track, index, lockedPrefix)) continue;
    if (waypointKeys.has(track.canonical_key) && track.canonical_key !== allowKey) continue;
    const distance = Math.abs(index - desiredIndex);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function stampWaypoint(track: StoredCopy, artist: string, routePosition: number) {
  const meta = parseObject(track.metadata_json);
  track.trajectory_position = routePosition;
  track.metadata_json = JSON.stringify({
    ...meta,
    gradientWaypoint: true,
    gradientRoutePosition: routePosition,
    gradientRouteConfidence: 1,
    gradientRouteArtist: artist,
    trajectoryCoordinateKind: "musical_route",
  });
}

/**
 * A track waypoint is stronger than a recommendation hint: if the user asks for
 * Track A → Track B, those exact recordings must occur at their waypoint regions.
 * Artist/album/genre/broad collection seeds remain regions where the route may
 * choose representative recordings. On a partially connected multipoint route,
 * exact track waypoints are only stamped/enforced when their coordinate belongs
 * to a leg that was actually discovered; disconnected legs must never acquire a
 * fake authoritative `musical_route` coordinate.
 *
 * Prefix, pinned and manual slots are stronger user locks. Missing exact-waypoint
 * tracks replace the nearest generated/unlocked slot instead of inserting rows
 * and shifting pins. Existing unlocked waypoint tracks are swapped into place so
 * every protected position remains byte-for-byte at the same playlist index.
 */
export function enforceExplicitGradientTrackWaypoints(
  generationId: string,
  options: { fromPosition?: number } = {},
) {
  const generation = getGeneration(generationId);
  const support = generation ? routeSupport(generation.diagnostics_json) : null;
  if (!generation || !support) return { applied: false, inserted: 0, moved: 0, skippedLocked: 0, skippedUnsupported: 0 };
  const tracks = getGenerationTracks(generationId);
  if (!tracks.length) return { applied: false, inserted: 0, moved: 0, skippedLocked: 0, skippedUnsupported: 0 };
  const seeds = getSeeds(generation.station_id).filter((seed) => seed.seed_type === "track" && seed.artist && seed.title);
  if (!seeds.length) return { applied: false, inserted: 0, moved: 0, skippedLocked: 0, skippedUnsupported: 0 };

  const output = tracks.map(copy);
  const lockedPrefix = Math.max(0, options.fromPosition ?? 0);
  let inserted = 0;
  let moved = 0;
  let skippedLocked = 0;
  let skippedUnsupported = 0;
  const desired = seeds.map((seed, index) => ({
    seed,
    routePosition: Math.max(0, Math.min(1, seed.position ?? (seeds.length <= 1 ? index : index / (seeds.length - 1)))),
  })).sort((a, b) => a.routePosition - b.routePosition);
  const waypointKeys = new Set(desired.map((item) => canonicalRadioTrackKey(item.seed.artist!, item.seed.title!)));

  for (const { seed, routePosition } of desired) {
    if (!supportsPosition(support, routePosition)) {
      skippedUnsupported++;
      continue;
    }

    const key = canonicalRadioTrackKey(seed.artist!, seed.title!);
    const idealIndex = Math.max(0, Math.min(output.length - 1, Math.round(routePosition * Math.max(0, output.length - 1))));
    let sourceIndex = output.findIndex((track) => track.canonical_key === key);

    if (sourceIndex >= 0) {
      stampWaypoint(output[sourceIndex]!, seed.artist!, routePosition);
      if (isProtected(output[sourceIndex]!, sourceIndex, lockedPrefix)) {
        // Respect the user's lock even when it means the exact seed recording is
        // not physically located at its ideal route slot.
        if (sourceIndex !== idealIndex) skippedLocked++;
        continue;
      }
      const targetIndex = nearestReplaceableIndex(output, idealIndex, lockedPrefix, waypointKeys, key);
      if (targetIndex < 0) {
        skippedLocked++;
        continue;
      }
      if (sourceIndex !== targetIndex) {
        [output[sourceIndex], output[targetIndex]] = [output[targetIndex]!, output[sourceIndex]!];
        moved++;
      }
      continue;
    }

    const targetIndex = nearestReplaceableIndex(output, idealIndex, lockedPrefix, waypointKeys);
    if (targetIndex < 0) {
      skippedLocked++;
      continue;
    }
    const metadata = {
      gradientWaypoint: true,
      gradientRoutePosition: routePosition,
      gradientRouteConfidence: 1,
      gradientRouteArtist: seed.artist,
      trajectoryCoordinateKind: "musical_route",
      providerScores: { seed: 1, gradient_route: 1 },
    };
    output[targetIndex] = {
      canonical_key: key,
      artist: seed.artist!,
      title: seed.title!,
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: null,
      navidrome_id: null,
      musicbrainz_id: null,
      playback_source: null,
      availability_status: "unknown",
      pinned: 0,
      manual: 0,
      selection_score: 2,
      trajectory_position: routePosition,
      metadata_json: JSON.stringify(metadata),
    };
    inserted++;
  }

  if (!inserted && !moved) return { applied: true, inserted: 0, moved: 0, skippedLocked, skippedUnsupported };
  replaceGenerationTracks(generationId, output);
  return { applied: true, inserted, moved, skippedLocked, skippedUnsupported };
}

export function isSameGradientWaypointTrack(track: RadioTrackRow, artist: string, title: string) {
  return normalizeForComparison(track.artist) === normalizeForComparison(artist)
    && normalizeForComparison(track.title) === normalizeForComparison(title);
}