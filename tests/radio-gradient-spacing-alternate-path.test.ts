import { describe, expect, test } from "bun:test";
import {
  densifyGradientRecordingPathWithSubpathFallback,
  gradientMaxEdgeShare,
} from "../src/services/radio-gradient-densify-subpath";
import {
  gradientRecording,
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
} from "../src/services/radio-gradient-recording-path";

function makePath(recordings: GradientRecording[], similarities: number[]): GradientRecordingPath {
  const edges = similarities.map((similarity, index) => ({
    from: recordings[index]!,
    to: recordings[index + 1]!,
    similarity,
    confidence: 1,
    provider: "synthetic",
  }));
  return {
    recordings,
    edges,
    cost: edges.reduce((sum, edge) => sum + gradientRecordingEdgeCost(edge.similarity, edge.confidence), 0),
    queryCount: 0,
    nodesVisited: recordings.length,
    forwardFrontierSize: 0,
    backwardFrontierSize: 0,
    intersection: null,
  };
}

function provider(graph: Record<string, Array<[GradientRecording, number]>>): GradientRecordingNeighborProvider {
  return {
    async neighbors(recording) {
      return (graph[recording.key] ?? []).map(([candidate, similarity]) => ({
        ...candidate,
        similarity,
        confidence: 1,
        provider: "synthetic",
      }));
    },
  };
}

describe("Gradient fixed-length alternate-path spacing repair", () => {
  test("repairs a dominant gap that requires three interior recordings", async () => {
    const p1 = gradientRecording("Poppy", "Girls in Bikinis");
    const p2 = gradientRecording("Poppy", "Chic Chick");
    const grimes = gradientRecording("Grimes featuring HANA", "We Appreciate Power");
    const p3 = gradientRecording("Poppy", "X");
    const slipknot = gradientRecording("Slipknot", "Psychosocial");
    const lamb = gradientRecording("Lamb of God", "Redneck");
    const slayer = gradientRecording("Slayer", "Raining Blood");
    const satyricon = gradientRecording("Satyricon", "K.I.N.G");
    const mayhem = gradientRecording("Mayhem", "Freezing Moon");
    const marduk = gradientRecording("Marduk", "Panzer Division Marduk");

    const a = gradientRecording("Bridge A", "A");
    const b = gradientRecording("Bridge B", "B");
    const c = gradientRecording("Bridge C", "C");

    const original = makePath(
      [p1, p2, grimes, p3, slipknot, lamb, slayer, satyricon, mayhem, marduk],
      [0.90, 0.85, 0.85, 0.08, 0.75, 0.80, 0.80, 0.80, 0.75],
    );
    const before = gradientMaxEdgeShare(original);
    expect(before).toBeGreaterThan(0.30);

    const graph = provider({
      // The weak Poppy -> Slipknot edge has no common neighbor and no two-interior
      // bridge. It only becomes traversable through three interior recordings.
      [p3.key]: [[a, 0.72], [slipknot, 0.08]],
      [a.key]: [[p3, 0.72], [b, 0.72]],
      [b.key]: [[a, 0.72], [c, 0.72]],
      [c.key]: [[b, 0.72], [slipknot, 0.72]],
      [slipknot.key]: [[c, 0.72], [p3, 0.08], [slayer, 0.82]],

      // Validated donor skips let the resampler reclaim the three extra slots
      // without touching either original weak-gap endpoint or inventing edges.
      [p1.key]: [[grimes, 0.82]],
      [slayer.key]: [[mayhem, 0.82]],
    });

    const result = await densifyGradientRecordingPathWithSubpathFallback(original, 10, graph, {
      maxQueries: 96,
      neighborLimit: 48,
      minBridgeSimilarity: 0.10,
      endpointArtists: ["Poppy", "Marduk"],
    });

    const keys = new Set(result.path.recordings.map((row) => row.key));
    expect(result.path.recordings).toHaveLength(10);
    expect(keys.has(a.key)).toBe(true);
    expect(keys.has(b.key)).toBe(true);
    expect(keys.has(c.key)).toBe(true);
    expect(keys.has(p3.key)).toBe(true);
    expect(keys.has(slipknot.key)).toBe(true);
    expect(keys.has(p2.key)).toBe(false);
    expect(keys.has(lamb.key)).toBe(false);
    expect(keys.has(satyricon.key)).toBe(false);
    expect(gradientMaxEdgeShare(result.path)).toBeLessThan(before - 0.01);
    expect(result.operations.some((operation) => operation.inserted.includes("Bridge B"))).toBe(true);
    expect(result.queryCount).toBeGreaterThan(0);
  });
});
