import { describe, expect, test } from "bun:test";
import {
  densifyGradientRecordingPathWithSubpathFallback,
  gradientMaxEdgeShare,
  gradientSpacingProfile,
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

describe("Gradient spacing balance", () => {
  test("replaces an incidental cliff endpoint when that gives a much smoother 10-track route", async () => {
    const start = gradientRecording("Poppy", "Girls In Bikinis");
    const grimes = gradientRecording("Grimes featuring HANA", "We Appreciate Power");
    const x = gradientRecording("Poppy", "X");
    const psych = gradientRecording("Slipknot", "Psychosocial");
    const soad = gradientRecording("System of a Down", "Chop Suey!");
    const sabbath = gradientRecording("Black Sabbath", "Paranoid");
    const venom = gradientRecording("Venom", "Countess Bathory");
    const mayhem = gradientRecording("Mayhem", "Freezing Moon");
    const marduk1 = gradientRecording("Marduk", "Christraping Black Metal");
    const end = gradientRecording("Marduk", "Panzer Division Marduk");
    const smoother = gradientRecording("Bridge Artist", "Smooth Connector");

    const original = makePath(
      [start, grimes, x, psych, soad, sabbath, venom, mayhem, marduk1, end],
      [0.72, 0.82, 0.08, 0.76, 0.68, 0.74, 0.80, 0.78, 0.84],
    );
    const before = gradientSpacingProfile(original);
    expect(before.idealShare).toBeCloseTo(1 / 9);
    expect(before.maxShare).toBeGreaterThan(0.30);

    const graph = provider({
      // There is no useful replacement for X itself. Psychosocial, however,
      // is incidental route output rather than a requested waypoint, and a
      // different recording really connects X to the following SOAD track.
      [x.key]: [[smoother, 0.70]],
      [soad.key]: [[smoother, 0.72]],
    });

    const result = await densifyGradientRecordingPathWithSubpathFallback(original, 10, graph, {
      maxQueries: 48,
      neighborLimit: 48,
      minBridgeSimilarity: 0.12,
      endpointArtists: ["Poppy", "Marduk"],
    });

    const titles = result.path.recordings.map((row) => row.title);
    const after = gradientSpacingProfile(result.path);
    expect(result.path.recordings).toHaveLength(10);
    expect(result.path.recordings[0]!.key).toBe(start.key);
    expect(result.path.recordings.at(-1)!.key).toBe(end.key);
    expect(titles).toContain("X");
    expect(titles).not.toContain("Psychosocial");
    expect(titles).toContain("Smooth Connector");
    expect(after.maxCost).toBeLessThan(before.maxCost * 0.96);
    expect(after.maxShare).toBeLessThan(0.20);
    expect(after.imbalance).toBeLessThan(before.imbalance);
  });

  test("treats roughly equal 10-track transition shares as the target shape", () => {
    const rows = Array.from({ length: 10 }, (_, index) => gradientRecording(`Artist ${index}`, `Track ${index}`));
    const path = makePath(rows, Array(9).fill(0.7));
    const profile = gradientSpacingProfile(path);
    expect(profile.idealShare).toBeCloseTo(1 / 9);
    expect(profile.maxShare).toBeCloseTo(1 / 9);
    expect(profile.imbalance).toBeCloseTo(0);
    expect(gradientMaxEdgeShare(path)).toBeCloseTo(1 / 9);
  });
});
