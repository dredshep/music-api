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

  test("no reusable state is created for an incomplete route", () => {
    const state = createGradientLiveRouteState("station", generation(4, false));
    expect(state).toBeNull();
  });

  test("exhausted non-completed state is rejected by validation", () => {
    const state = createGradientLiveRouteState("station", generation(4))!;
    expect(state).not.toBeNull();
    const result = consumeGradientLiveRouteState(state, 10, new Set());
    expect(result.completed).toBe(true);
    expect(result.state.next_index).toBe(4);
    expect(isValidGradientLiveRouteState("station", result.state)).toBe(true);

    const nonCompleteExhausted = { ...result.state, completed: false, route_complete: false };
    expect(isValidGradientLiveRouteState("station", nonCompleteExhausted)).toBe(false);
  });

  test("final endpoint status overrides planner endpoint status", () => {
    const gen = generation(6, true);
    const diag = gen.diagnostics as Record<string, unknown>;
    diag.gradient_final_endpoint_status = { start_satisfied: false, end_satisfied: true };
    const state = createGradientLiveRouteState("station", gen);
    expect(state).toBeNull();

    diag.gradient_final_endpoint_status = { start_satisfied: true, end_satisfied: true };
    const state2 = createGradientLiveRouteState("station", gen);
    expect(state2).not.toBeNull();
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
