import { describe, expect, test } from "bun:test";
import type { RadioTrackRow } from "../src/db/repositories/radio";
import {
  countGradientRouteBacktracks,
  musicalRoutePosition,
  repairGradientRouteSegmentOrder,
} from "../src/services/radio-gradient-order-guard";

function track(id: string, route: number | null, position: number, kind: "musical_route" | "legacy" = "musical_route"): RadioTrackRow {
  return {
    id,
    generation_id: "g",
    position,
    canonical_key: `text:${id}|${id}`,
    artist: id,
    title: id,
    album: null,
    duration_ms: 200000,
    isrc: null,
    spotify_id: null,
    navidrome_id: `nd-${id}`,
    musicbrainz_id: null,
    playback_source: "navidrome",
    availability_status: "local",
    pinned: 0,
    manual: 0,
    selection_score: 1,
    trajectory_position: route,
    metadata_json: JSON.stringify({ trajectoryCoordinateKind: kind }),
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("Gradient route order guard", () => {
  test("repairs a DJ-induced musical-route inversion", () => {
    const segment = [
      track("a", 0.12, 0),
      track("c", 0.72, 1),
      track("b", 0.43, 2),
      track("d", 0.91, 3),
    ];
    expect(countGradientRouteBacktracks(segment)).toBe(1);
    const repaired = repairGradientRouteSegmentOrder(segment);
    expect(repaired.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(countGradientRouteBacktracks(repaired)).toBe(0);
  });

  test("leaves unknown-coordinate slots in place while ordering known route tracks", () => {
    const segment = [
      track("late", 0.8, 0),
      track("unknown", null, 1),
      track("early", 0.2, 2),
    ];
    const repaired = repairGradientRouteSegmentOrder(segment);
    expect(repaired.map((row) => row.id)).toEqual(["early", "unknown", "late"]);
  });

  test("legacy/index percentages are never treated as musical coordinates", () => {
    const legacy = track("legacy", 0.9, 0, "legacy");
    expect(musicalRoutePosition(legacy)).toBeNull();
    expect(repairGradientRouteSegmentOrder([legacy, track("route", 0.2, 1)]).map((row) => row.id)).toEqual(["legacy", "route"]);
  });
});
