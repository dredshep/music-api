import { describe, expect, test } from "bun:test";
import {
  countGradientStageBacktracks,
  countMovedTracks,
  countResolutionChanges,
  summarizeGradientCandidateRegions,
  summarizeGradientStage,
} from "../src/services/radio-gradient-observability";

function track(id: string, position: number, routePosition: number | null, extra: Record<string, unknown> = {}) {
  const metadata = routePosition == null ? {} : {
    trajectoryCoordinateKind: "musical_route",
    gradientRoutePosition: routePosition,
    trajectoryTarget: position / 3,
  };
  return {
    id,
    generation_id: "generation",
    position,
    canonical_key: id,
    artist: `Artist ${id}`,
    title: `Track ${id}`,
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
    selection_score: 1,
    trajectory_position: routePosition,
    metadata_json: JSON.stringify({ ...metadata, ...extra }),
  } as any;
}

describe("Gradient pipeline observability", () => {
  test("summarizes only authoritative musical-route coordinates", () => {
    const tracks = [
      track("a", 0, 0.1),
      track("b", 1, 0.45, { gradientWaypoint: true }),
      track("legacy", 2, null),
      track("c", 3, 0.9),
    ];
    tracks[2].trajectory_position = 0.7;

    const summary = summarizeGradientStage(tracks);
    expect(summary.count).toBe(4);
    expect(summary.positioned_count).toBe(3);
    expect(summary.positioned_ratio).toBe(0.75);
    expect(summary.backtracks).toBe(0);
    expect(summary.first_route_position).toBe(0.1);
    expect(summary.last_route_position).toBe(0.9);
    expect(summary.tracks[1]).toMatchObject({ waypoint: true, route_position: 0.45 });
    expect(summary.tracks[2]).toMatchObject({ route_position: null });
  });

  test("reports meaningful route backtracks while skipping unknown coordinates", () => {
    const tracks = [track("a", 0, 0.1), track("unknown", 1, null), track("b", 2, 0.7), track("c", 3, 0.5)];
    expect(countGradientStageBacktracks(tracks)).toBe(1);
  });

  test("groups materialized candidates by route artist and coordinate", () => {
    expect(summarizeGradientCandidateRegions([
      { routeArtist: "A", routePosition: 0 },
      { routeArtist: "A", routePosition: 0 },
      { routeArtist: "Bridge", routePosition: 0.5 },
      { routeArtist: "B", routePosition: 1 },
    ])).toEqual([
      { artist: "A", position: 0, candidate_count: 2 },
      { artist: "Bridge", position: 0.5, candidate_count: 1 },
      { artist: "B", position: 1, candidate_count: 1 },
    ]);
  });

  test("counts DJ moves and local-resolution changes independently", () => {
    const before = [track("a", 0, 0.1), track("b", 1, 0.9)];
    const moved = [track("b", 0, 0.9), track("a", 1, 0.1)];
    expect(countMovedTracks(before, moved)).toBe(2);

    const resolved = [track("a", 0, 0.1), track("b", 1, 0.9)];
    resolved[1].playback_source = "navidrome";
    resolved[1].availability_status = "local";
    resolved[1].navidrome_id = "nav-b";
    expect(countResolutionChanges(before, resolved)).toBe(1);
  });

  test("does not report movement solely because playlist rows were recreated", () => {
    const before = [track("a", 0, 0.1), track("b", 1, 0.9)];
    const recreated = [track("a", 0, 0.1), track("b", 1, 0.9)];
    recreated[0].id = "new-row-a";
    recreated[1].id = "new-row-b";
    expect(countMovedTracks(before, recreated)).toBe(0);
    expect(countResolutionChanges(before, recreated)).toBe(0);
  });
});
