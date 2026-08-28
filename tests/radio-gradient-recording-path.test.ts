import { describe, expect, test } from "bun:test";
import {
  densifyGradientRecordingPath,
  discoverGradientRecordingPath,
  gradientFamiliarityTarget,
  gradientRecording,
  type GradientRecording,
  type GradientRecordingNeighborProvider,
} from "../src/services/radio-gradient-recording-path";

function provider(graph: Record<string, Array<[string, string, number]>>): GradientRecordingNeighborProvider {
  return {
    async neighbors(recording) {
      return (graph[recording.key] ?? []).map(([artist, title, similarity]) => ({
        ...gradientRecording(artist, title),
        similarity,
        confidence: 1,
        provider: "synthetic",
      }));
    },
  };
}

function key(artist: string, title: string) {
  return gradientRecording(artist, title).key;
}

describe("recording-level Gradient path search", () => {
  test("finds the actual recording chain between endpoint regions", async () => {
    const a = gradientRecording("A", "a");
    const b = gradientRecording("B", "b");
    const x = gradientRecording("X", "x");
    const y = gradientRecording("Y", "y");
    const graph = provider({
      [a.key]: [["X", "x", 0.9]],
      [x.key]: [["A", "a", 0.9], ["Y", "y", 0.8]],
      [y.key]: [["X", "x", 0.8], ["B", "b", 0.9]],
      [b.key]: [["Y", "y", 0.9]],
    });

    const path = await discoverGradientRecordingPath([a], [b], graph, { maxQueries: 24, refineQueries: 2 });
    expect(path).not.toBeNull();
    expect(path!.recordings.map((row) => row.artist)).toEqual(["A", "X", "Y", "B"]);
    expect(path!.recordings[0]!.title).toBe("a");
    expect(path!.recordings.at(-1)!.title).toBe("b");
  });

  test("bidirectional search escapes a tempting greedy dead end", async () => {
    const a = gradientRecording("A", "a");
    const b = gradientRecording("B", "b");
    const trap1 = gradientRecording("Trap", "one");
    const trap2 = gradientRecording("Trap", "two");
    const bridge1 = gradientRecording("Bridge", "one");
    const bridge2 = gradientRecording("Bridge", "two");
    const graph = provider({
      [a.key]: [["Trap", "one", 0.99], ["Bridge", "one", 0.76]],
      [trap1.key]: [["Trap", "two", 0.99]],
      [trap2.key]: [["Trap", "one", 0.99]],
      [bridge1.key]: [["A", "a", 0.76], ["Bridge", "two", 0.76]],
      [bridge2.key]: [["Bridge", "one", 0.76], ["B", "b", 0.76]],
      [b.key]: [["Bridge", "two", 0.76]],
    });

    const path = await discoverGradientRecordingPath([a], [b], graph, {
      maxQueries: 32,
      beamPerSide: 3,
      refineQueries: 4,
    });
    expect(path).not.toBeNull();
    expect(path!.recordings.map((row) => row.artist)).toEqual(["A", "Bridge", "Bridge", "B"]);
    expect(path!.recordings.map((row) => row.key)).not.toContain(trap2.key);
  });

  test("artist endpoint regions still yield recordings by the requested artists", async () => {
    const a1 = gradientRecording("Artist A", "bright");
    const a2 = gradientRecording("Artist A", "heavy");
    const b1 = gradientRecording("Artist B", "soft");
    const b2 = gradientRecording("Artist B", "dark");
    const middle = gradientRecording("Middle", "bridge");
    const graph = provider({
      [a1.key]: [],
      [a2.key]: [["Middle", "bridge", 0.85]],
      [middle.key]: [["Artist A", "heavy", 0.85], ["Artist B", "dark", 0.85]],
      [b1.key]: [],
      [b2.key]: [["Middle", "bridge", 0.85]],
    });

    const path = await discoverGradientRecordingPath([a1, a2], [b1, b2], graph, { maxQueries: 24 });
    expect(path).not.toBeNull();
    expect(path!.recordings[0]!.artist).toBe("Artist A");
    expect(path!.recordings[0]!.title).toBe("heavy");
    expect(path!.recordings.at(-1)!.artist).toBe("Artist B");
    expect(path!.recordings.at(-1)!.title).toBe("dark");
  });
});

describe("recording-level Gradient densification", () => {
  test("chooses the candidate that bridges both sides instead of the left-only favorite", async () => {
    const a = gradientRecording("A", "a");
    const d = gradientRecording("D", "d");
    const b = gradientRecording("B", "b");
    const c = gradientRecording("C", "c");
    const graph = provider({
      [a.key]: [["B", "b", 0.9], ["C", "c", 0.7]],
      [d.key]: [["B", "b", 0.1], ["C", "c", 0.7]],
    });
    const original = {
      recordings: [a, d],
      edges: [{ from: a, to: d, similarity: 0.2, confidence: 1, provider: "synthetic" }],
      cost: 1,
      queryCount: 0,
      nodesVisited: 2,
      forwardFrontierSize: 0,
      backwardFrontierSize: 0,
      intersection: null,
    };

    const dense = await densifyGradientRecordingPath(original, 3, graph, { minBridgeSimilarity: 0.05 });
    expect(dense.path.recordings.map((row) => row.artist)).toEqual(["A", "C", "D"]);
    expect(dense.operations[0]!.bottleneck).toBeCloseTo(0.7, 5);
  });

  test("forbids endpoint artists from filling the discovery core", async () => {
    const a = gradientRecording("Endpoint A", "start");
    const d = gradientRecording("Endpoint B", "end");
    const endpointFiller = gradientRecording("Endpoint A", "another");
    const novel = gradientRecording("Novel", "middle");
    const graph = provider({
      [a.key]: [[endpointFiller.artist, endpointFiller.title, 0.95], [novel.artist, novel.title, 0.75]],
      [d.key]: [[endpointFiller.artist, endpointFiller.title, 0.95], [novel.artist, novel.title, 0.75]],
    });
    const original = {
      recordings: [a, d],
      edges: [{ from: a, to: d, similarity: 0.2, confidence: 1, provider: "synthetic" }],
      cost: 1,
      queryCount: 0,
      nodesVisited: 2,
      forwardFrontierSize: 0,
      backwardFrontierSize: 0,
      intersection: null,
    };

    const dense = await densifyGradientRecordingPath(original, 3, graph, {
      endpointArtists: ["Endpoint A", "Endpoint B"],
      minBridgeSimilarity: 0.05,
    });
    expect(dense.path.recordings[1]!.artist).toBe("Novel");
  });

  test("familiarity target is U-shaped with maximum novelty in the middle", () => {
    expect(gradientFamiliarityTarget(0)).toBeCloseTo(1, 8);
    expect(gradientFamiliarityTarget(1)).toBeCloseTo(1, 8);
    expect(gradientFamiliarityTarget(0.5)).toBeCloseTo(0, 8);
    expect(gradientFamiliarityTarget(0.25)).toBeGreaterThan(gradientFamiliarityTarget(0.5));
    expect(gradientFamiliarityTarget(0.75)).toBeGreaterThan(gradientFamiliarityTarget(0.5));
  });
});
