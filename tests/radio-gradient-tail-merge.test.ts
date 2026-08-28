import { describe, expect, test } from "bun:test";
import type { RadioTrackRow } from "../src/db/repositories/radio";
import {
  assessGradientMergedEndpoints,
  mergeGradientPlannedTail,
  reprojectGradientLockedTrack,
  type StoredGradientTrack,
} from "../src/services/radio-gradient-tail-merge";

function existing(position: number, key: string, options: Partial<RadioTrackRow> = {}): RadioTrackRow {
  return {
    id: `id-${position}`,
    generation_id: "generation",
    position,
    canonical_key: key,
    artist: key,
    title: key,
    album: "old album",
    duration_ms: 100,
    isrc: null,
    spotify_id: `spotify-${position}`,
    navidrome_id: null,
    musicbrainz_id: null,
    playback_source: "spotify",
    availability_status: "spotify",
    pinned: 0,
    manual: 0,
    selection_score: 0.5,
    trajectory_position: position / 4,
    metadata_json: JSON.stringify({
      trajectoryCoordinateKind: "musical_route",
      gradientRoutePosition: position / 4,
      gradientRouteConfidence: 0.8,
      oldMarker: true,
    }),
    created_at: "2026-01-01T00:00:00.000Z",
    ...options,
  };
}

function planned(key: string, position: number): StoredGradientTrack {
  return {
    canonical_key: key,
    artist: key,
    title: key,
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
    selection_score: 0.9,
    trajectory_position: position,
    metadata_json: JSON.stringify({
      trajectoryCoordinateKind: "musical_route",
      gradientRoutePosition: position,
      gradientRouteConfidence: 0.9,
      gradientRouteModel: "recording_path_v1",
    }),
  };
}

describe("Gradient tail merge", () => {
  test("reprojects a preserved prefix track onto the new route without losing playback identity", () => {
    const old = existing(0, "A");
    const result = reprojectGradientLockedTrack(old, planned("A", 0.12));
    expect(result.trajectory_position).toBe(0.12);
    expect(result.spotify_id).toBe("spotify-0");
    expect(result.availability_status).toBe("spotify");
    const metadata = JSON.parse(result.metadata_json!);
    expect(metadata.gradientRoutePosition).toBe(0.12);
    expect(metadata.gradientLockedReprojected).toBe(true);
    expect(metadata.oldMarker).toBe(true);
  });

  test("keeps an off-route pin but removes its stale musical coordinate honestly", () => {
    const old = existing(2, "Manual detour", { pinned: 1 });
    const result = reprojectGradientLockedTrack(old, null);
    expect(result.pinned).toBe(1);
    expect(result.trajectory_position).toBeNull();
    const metadata = JSON.parse(result.metadata_json!);
    expect(metadata.trajectoryCoordinateKind).toBeUndefined();
    expect(metadata.gradientRoutePosition).toBeUndefined();
    expect(metadata.gradientLockedOffRoute).toBe(true);
    expect(metadata.gradientRouteUnsupported).toBe(true);
  });

  test("preserves locked slots and fills all other slots from the new route without duplicates", () => {
    const old = [
      existing(0, "A"),
      existing(1, "OLD-1"),
      existing(2, "Pinned", { pinned: 1 }),
      existing(3, "OLD-3"),
      existing(4, "B"),
    ];
    const route = [planned("A", 0), planned("X", 0.25), planned("Pinned", 0.5), planned("Y", 0.75), planned("B", 1)];
    const merged = mergeGradientPlannedTail(old, route, 5, 1);
    expect(merged.map((row) => row.canonical_key)).toEqual(["A", "X", "Pinned", "Y", "B"]);
    expect(merged[0]!.trajectory_position).toBe(0);
    expect(merged[2]!.pinned).toBe(1);
    expect(merged[2]!.trajectory_position).toBe(0.5);
  });

  test("an off-route manual lock occupies its slot while planned duplicates are skipped", () => {
    const old = [
      existing(0, "A"),
      existing(1, "Manual", { manual: 1 }),
      existing(2, "OLD"),
      existing(3, "B"),
    ];
    const route = [planned("A", 0), planned("X", 0.33), planned("Y", 0.66), planned("B", 1)];
    const merged = mergeGradientPlannedTail(old, route, 4, 1);
    expect(merged.map((row) => row.canonical_key)).toEqual(["A", "Manual", "X", "Y"]);
    expect(merged[1]!.trajectory_position).toBeNull();
    expect(JSON.parse(merged[1]!.metadata_json!).gradientLockedOffRoute).toBe(true);
  });

  test("reports an endpoint lock conflict when a user lock displaces hard B", () => {
    const merged = [planned("A", 0), planned("X", 0.5), planned("Pinned outro", 0.8)];
    const status = assessGradientMergedEndpoints(
      merged,
      { constraint: "artist", requestedArtist: "A", exactCanonicalKey: null, requestedMbid: null },
      { constraint: "artist", requestedArtist: "B", exactCanonicalKey: null, requestedMbid: null },
    );
    expect(status.startSatisfied).toBe(true);
    expect(status.endSatisfied).toBe(false);
    expect(status.conflict).toBe(true);
  });

  test("broad region endpoints do not become hard endpoint constraints", () => {
    const status = assessGradientMergedEndpoints(
      [planned("Whatever", 0), planned("Elsewhere", 1)],
      { constraint: "region", requestedArtist: null, exactCanonicalKey: null, requestedMbid: null },
      { constraint: "region", requestedArtist: null, exactCanonicalKey: null, requestedMbid: null },
    );
    expect(status.satisfied).toBe(true);
  });

  test("exact_track with matching canonical key but wrong MBID is not satisfied", () => {
    const tracks: StoredGradientTrack[] = [
      { ...planned("SongA", 0), musicbrainz_id: "mbid-wrong" },
      planned("SongB", 1),
    ];
    const status = assessGradientMergedEndpoints(
      tracks,
      { constraint: "exact_track", requestedArtist: "SongA", exactCanonicalKey: "SongA", requestedMbid: "mbid-correct" },
      { constraint: "region", requestedArtist: null, exactCanonicalKey: null, requestedMbid: null },
    );
    expect(status.startSatisfied).toBe(false);
    expect(status.conflict).toBe(true);
  });

  test("exact_track with matching canonical key and matching MBID is satisfied", () => {
    const tracks: StoredGradientTrack[] = [
      { ...planned("SongA", 0), musicbrainz_id: "mbid-123" },
      planned("SongB", 1),
    ];
    const status = assessGradientMergedEndpoints(
      tracks,
      { constraint: "exact_track", requestedArtist: "SongA", exactCanonicalKey: "SongA", requestedMbid: "mbid-123" },
      { constraint: "region", requestedArtist: null, exactCanonicalKey: null, requestedMbid: null },
    );
    expect(status.startSatisfied).toBe(true);
    expect(status.satisfied).toBe(true);
  });

  test("exact_track MBID check is skipped when track has no musicbrainz_id", () => {
    const tracks: StoredGradientTrack[] = [
      { ...planned("SongA", 0), musicbrainz_id: null },
      planned("SongB", 1),
    ];
    const status = assessGradientMergedEndpoints(
      tracks,
      { constraint: "exact_track", requestedArtist: "SongA", exactCanonicalKey: "SongA", requestedMbid: "mbid-123" },
      { constraint: "region", requestedArtist: null, exactCanonicalKey: null, requestedMbid: null },
    );
    expect(status.startSatisfied).toBe(true);
  });
});
