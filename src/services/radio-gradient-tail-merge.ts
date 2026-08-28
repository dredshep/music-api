import type { RadioTrackRow } from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";

export type StoredGradientTrack = {
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
  availability_status: string;
  pinned: number;
  manual: number;
  selection_score: number;
  trajectory_position: number | null;
  metadata_json: string | null;
};

export type GradientHardEndpointExpectation = {
  constraint: "exact_track" | "artist" | "region";
  requestedArtist: string | null;
  exactCanonicalKey: string | null;
  requestedMbid: string | null;
};

function parseObject(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function stripRouteMetadata(metadata: Record<string, unknown>) {
  const output = { ...metadata };
  for (const key of [
    "trajectoryCoordinateKind",
    "gradientRoutePosition",
    "gradientRouteConfidence",
    "gradientRouteArtist",
    "gradientRouteRecordingMbid",
    "gradientRouteModel",
    "gradientRouteSource",
    "gradientRouteUnsupported",
    "familiarityTarget",
    "familiarityActual",
  ]) delete output[key];
  return output;
}

function copyExisting(track: RadioTrackRow): StoredGradientTrack {
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

/** Reproject a locked track onto the newly discovered route when possible. */
export function reprojectGradientLockedTrack(
  track: RadioTrackRow,
  planned: StoredGradientTrack | null,
): StoredGradientTrack {
  const existing = copyExisting(track);
  const existingMetadata = stripRouteMetadata(parseObject(track.metadata_json));
  if (!planned) {
    return {
      ...existing,
      trajectory_position: null,
      metadata_json: JSON.stringify({
        ...existingMetadata,
        gradientLockedOffRoute: true,
        gradientRouteUnsupported: true,
      }),
    };
  }

  const plannedMetadata = parseObject(planned.metadata_json);
  return {
    ...planned,
    // User locks preserve the actual playable identity/resolution already saved.
    artist: track.artist,
    title: track.title,
    album: track.album ?? planned.album,
    duration_ms: track.duration_ms ?? planned.duration_ms,
    isrc: track.isrc ?? planned.isrc,
    spotify_id: track.spotify_id ?? planned.spotify_id,
    navidrome_id: track.navidrome_id ?? planned.navidrome_id,
    musicbrainz_id: track.musicbrainz_id ?? planned.musicbrainz_id,
    playback_source: track.playback_source ?? planned.playback_source,
    availability_status: track.availability_status !== "unknown" ? track.availability_status : planned.availability_status,
    pinned: track.pinned,
    manual: track.manual,
    metadata_json: JSON.stringify({
      ...existingMetadata,
      ...plannedMetadata,
      gradientLockedReprojected: true,
    }),
  };
}

/**
 * Preserve prefix/pinned/manual positions while rebuilding every unlocked slot
 * from the new recording path. Locked tracks are not allowed to retain stale
 * coordinates from the previous route.
 */
export function mergeGradientPlannedTail(
  existing: RadioTrackRow[],
  planned: StoredGradientTrack[],
  requestedLength: number,
  fromPosition: number,
) {
  const plannedByKey = new Map(planned.map((track) => [track.canonical_key, track]));
  const locked = new Map(existing
    .filter((track) => track.position < fromPosition || Boolean(track.pinned) || Boolean(track.manual))
    .map((track) => [track.position, reprojectGradientLockedTrack(track, plannedByKey.get(track.canonical_key) ?? null)]));

  const output: StoredGradientTrack[] = [];
  const used = new Set<string>();
  let plannedCursor = 0;
  for (let position = 0; position < requestedLength; position++) {
    const fixed = locked.get(position);
    if (fixed) {
      output.push(fixed);
      used.add(fixed.canonical_key);
      continue;
    }
    while (plannedCursor < planned.length && used.has(planned[plannedCursor]!.canonical_key)) plannedCursor++;
    const candidate = planned[plannedCursor++];
    if (!candidate) continue;
    output.push(candidate);
    used.add(candidate.canonical_key);
  }
  return output;
}

function endpointMatches(track: StoredGradientTrack | undefined, expectation: GradientHardEndpointExpectation) {
  if (expectation.constraint === "region") return true;
  if (!track) return false;
  if (expectation.constraint === "exact_track") {
    if (!expectation.exactCanonicalKey || track.canonical_key !== expectation.exactCanonicalKey) return false;
    if (expectation.requestedMbid && expectation.requestedMbid !== track.musicbrainz_id) return false;
    return true;
  }
  return Boolean(
    expectation.requestedArtist
    && normalizeForComparison(track.artist) === normalizeForComparison(expectation.requestedArtist),
  );
}

/** Check hard endpoint semantics against the actual merged playlist, not the abstract plan. */
export function assessGradientMergedEndpoints(
  tracks: StoredGradientTrack[],
  start: GradientHardEndpointExpectation,
  end: GradientHardEndpointExpectation,
) {
  const startSatisfied = endpointMatches(tracks[0], start);
  const endSatisfied = endpointMatches(tracks.at(-1), end);
  return {
    startSatisfied,
    endSatisfied,
    satisfied: startSatisfied && endSatisfied,
    conflict: !(startSatisfied && endSatisfied),
    firstKey: tracks[0]?.canonical_key ?? null,
    lastKey: tracks.at(-1)?.canonical_key ?? null,
  };
}
