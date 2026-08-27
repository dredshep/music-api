import { describe, expect, test } from "bun:test";
import { selectGradientLiveWindow } from "../src/services/radio-live-window";

function routed(key: string, route: number) {
  return {
    canonical_key: key,
    trajectory_position: route,
    metadata: { trajectoryCoordinateKind: "musical_route" },
  };
}

function unknown(key: string) {
  return {
    canonical_key: key,
    trajectory_position: null,
    metadata: {},
  };
}

describe("Gradient live route windows", () => {
  test("subsequent batches begin after the previous musical-route cursor", () => {
    const tracks = Array.from({ length: 10 }, (_, index) => routed(`t${index}`, index / 9));
    const first = selectGradientLiveWindow(tracks, { count: 3, cursor: 0 });
    expect(first.tracks.map((track) => track.canonical_key)).toEqual(["t0", "t1", "t2"]);
    expect(first.nextCursor).toBeGreaterThan(2 / 9);

    const second = selectGradientLiveWindow(tracks, { count: 3, cursor: first.nextCursor });
    expect(second.tracks.map((track) => track.canonical_key)).toEqual(["t3", "t4", "t5"]);
    expect(second.tracks[0]!.trajectory_position).toBeGreaterThan(first.tracks.at(-1)!.trajectory_position!);
  });

  test("keeps unknown-coordinate local slots while progressing through a connected route", () => {
    const tracks = [
      routed("a", 0),
      unknown("fallback-a"),
      routed("middle", 0.5),
      unknown("fallback-b"),
      routed("b", 1),
    ];
    const batch = selectGradientLiveWindow(tracks, { count: 3, cursor: 0.49 });
    expect(batch.tracks.map((track) => track.canonical_key)).toEqual(["middle", "fallback-b", "b"]);
    expect(batch.nextCursor).toBe(0);
  });

  test("wraps only after reaching the end of the route instead of restarting every refill", () => {
    const tracks = [routed("a", 0), routed("x", 0.33), routed("y", 0.66), routed("b", 1)];
    const batch = selectGradientLiveWindow(tracks, { count: 3, cursor: 0.65 });
    expect(batch.tracks.map((track) => track.canonical_key)).toEqual(["y", "b", "a"]);
    expect(batch.wrapped).toBe(true);
    expect(batch.nextCursor).toBeGreaterThan(0);
    expect(batch.nextCursor).toBeLessThan(0.01);
  });

  test("exclusions do not move the cursor backwards", () => {
    const tracks = [routed("a", 0), routed("x", 0.25), routed("y", 0.5), routed("z", 0.75), routed("b", 1)];
    const batch = selectGradientLiveWindow(tracks, {
      count: 2,
      cursor: 0.24,
      excludeKeys: new Set(["x"]),
    });
    expect(batch.tracks.map((track) => track.canonical_key)).toEqual(["y", "z"]);
    expect(batch.nextCursor).toBeGreaterThan(0.75);
  });

  test("returns no cursor when the generation has no authoritative route coordinates", () => {
    const batch = selectGradientLiveWindow([unknown("one"), unknown("two"), unknown("three")], { count: 2, cursor: 0.6 });
    expect(batch.tracks.map((track) => track.canonical_key)).toEqual(["one", "two"]);
    expect(batch.routeCursor).toBeNull();
    expect(batch.nextCursor).toBeNull();
    expect(batch.wrapped).toBe(false);
  });
});