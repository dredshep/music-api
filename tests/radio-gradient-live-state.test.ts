import { describe, expect, test } from "bun:test";
import {
  consumeGradientLiveRouteState,
  createGradientLiveRouteState,
  isValidGradientLiveRouteState,
  type GradientLivePresentedTrack,
} from "../src/services/radio-gradient-live-state";

function track(index: number, total = 10): GradientLivePresentedTrack {
  const position = total <= 1 ? 0 : index / (total - 1);
  return {
    id: `id-${index}`,
    position: index,
    canonical_key: `text:artist-${index}|track-${index}`,
    artist: `Artist ${index}`,
    title: `Track ${index}`,
    album: null,
    duration_ms: 180000,
    isrc: null,
    spotify_id: `spotify-${index}`,
    navidrome_id: null,
    musicbrainz_id: null,
    playback_source: "spotify",
    availability: "spotify",
    pinned: false,
    manual: false,
    score: 1,
    trajectory_position: position,
    metadata: { trajectoryCoordinateKind: "musical_route" },
  };
}

function generation(total = 10, routeComplete = true) {
  return {
    generator_version: "radio-v5-gradient-recording-geodesic",
    diagnostics: {
      gradient_route: {
        model: "recording_path_v1",
        usable: true,
        complete: routeComplete,
        endpoint_status: {
          start_satisfied: routeComplete,
          end_satisfied: routeComplete,
        },
      },
      gradient_fallback_radio: false,
    },
    tracks: Array.from({ length: total }, (_, index) => track(index, total)),
  };
}

describe("Gradient Live route state", () => {
  test("consumes one planned recording path across refill boundaries without restarting", () => {
    const state = createGradientLiveRouteState("station", generation(10));
    expect(state).not.toBeNull();

    const first = consumeGradientLiveRouteState(state!, 4, new Set());
    expect(first.tracks.map((row) => row.title)).toEqual(["Track 0", "Track 1", "Track 2", "Track 3"]);
    expect(first.state.next_index).toBe(4);
    expect(first.completed).toBe(false);

    const second = consumeGradientLiveRouteState(first.state, 4, new Set());
    expect(second.tracks.map((row) => row.title)).toEqual(["Track 4", "Track 5", "Track 6", "Track 7"]);
    expect(second.state.next_index).toBe(8);
    expect(second.state.previous_key).toBe("text:artist-7|track-7");
    expect(second.completed).toBe(false);
  });

  test("exclusions advance through the same route instead of causing a fresh search", () => {
    const state = createGradientLiveRouteState("station", generation(8))!;
    const result = consumeGradientLiveRouteState(state, 4, new Set([
      "text:artist-1|track-1",
      "text:artist-2|track-2",
    ]));
    expect(result.tracks.map((row) => row.title)).toEqual(["Track 0", "Track 3", "Track 4", "Track 5"]);
    expect(result.state.next_index).toBe(6);
    expect(result.completed).toBe(false);
  });

  test("reaches B once and marks the route complete rather than wrapping back to A", () => {
    const initial = createGradientLiveRouteState("station", generation(6))!;
    const first = consumeGradientLiveRouteState(initial, 4, new Set());
    const final = consumeGradientLiveRouteState(first.state, 4, new Set());
    expect(final.tracks.map((row) => row.title)).toEqual(["Track 4", "Track 5"]);
    expect(final.completed).toBe(true);
    expect(final.state.completed).toBe(true);
    expect(final.state.next_index).toBe(6);
    expect(final.nextCursor).toBe(1);
    expect(final.state.previous_key).toBe("text:artist-5|track-5");
  });

  test("partial route does not falsely complete when array is exhausted", () => {
    const initial = createGradientLiveRouteState("station", generation(4, false))!;
    expect(initial).not.toBeNull();
    expect(initial.route_complete).toBe(false);
    const result = consumeGradientLiveRouteState(initial, 10, new Set());
    expect(result.tracks).toHaveLength(4);
    expect(result.completed).toBe(false);
    expect(result.state.completed).toBe(false);
  });

  test("only creates reusable state for a genuine non-fallback recording path", () => {
    expect(createGradientLiveRouteState("station", {
      ...generation(5),
      diagnostics: { gradient_route: { model: "artist_path", usable: true } },
    })).toBeNull();
    expect(createGradientLiveRouteState("station", {
      ...generation(5),
      diagnostics: {
        gradient_route: { model: "recording_path_v1", usable: true },
        gradient_fallback_radio: true,
      },
    })).toBeNull();
    const state = createGradientLiveRouteState("station", generation(5));
    expect(isValidGradientLiveRouteState("station", state)).toBe(true);
    expect(isValidGradientLiveRouteState("other-station", state)).toBe(false);
  });
});
