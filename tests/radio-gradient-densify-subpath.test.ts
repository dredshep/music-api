import { describe, expect, test } from "bun:test";
import { densifyGradientRecordingPathWithSubpathFallback } from "../src/services/radio-gradient-densify-subpath";
import {
  gradientRecording,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
} from "../src/services/radio-gradient-recording-path";

function provider(
  graph: Record<string, Array<[string, string, number]>>,
  onLookup?: () => void,
): GradientRecordingNeighborProvider {
  return {
    async neighbors(recording) {
      onLookup?.();
      return (graph[recording.title] ?? []).map(([artist, title, similarity]) => ({
        ...gradientRecording(artist, title),
        similarity,
        confidence: 1,
        provider: "test",
      }));
    },
  };
}

function twoNodePath(): GradientRecordingPath {
  const a = gradientRecording("A", "A");
  const b = gradientRecording("B", "B");
  return {
    recordings: [a, b],
    edges: [{ from: a, to: b, similarity: 0.15, confidence: 1, provider: "weak-direct" }],
    cost: 1,
    queryCount: 0,
    nodesVisited: 2,
    forwardFrontierSize: 0,
    backwardFrontierSize: 0,
    intersection: null,
  };
}

describe("Gradient multi-hop densification fallback", () => {
  test("inserts C and D when no single common neighbor bridges A and B", async () => {
    const path = twoNodePath();
    const p = provider({
      A: [["C", "C", 0.78]],
      B: [["D", "D", 0.76]],
      C: [["D", "D", 0.74]],
      D: [["C", "C", 0.74]],
    });
    const dense = await densifyGradientRecordingPathWithSubpathFallback(path, 4, p, {
      minBridgeSimilarity: 0.2,
      maxQueries: 30,
    });
    expect(dense.path.recordings.map((row) => row.title)).toEqual(["A", "C", "D", "B"]);
    expect(dense.path.edges.map((edge) => Number(edge.similarity.toFixed(2)))).toEqual([0.78, 0.74, 0.76]);
    expect(dense.stoppedReason).toBe("requested_length");
  });

  test("does not invent a subpath when the three-edge bottleneck is below threshold", async () => {
    const path = twoNodePath();
    const p = provider({
      A: [["C", "C", 0.8]],
      B: [["D", "D", 0.8]],
      C: [["D", "D", 0.05]],
    });
    const dense = await densifyGradientRecordingPathWithSubpathFallback(path, 4, p, {
      minBridgeSimilarity: 0.2,
      maxQueries: 30,
    });
    expect(dense.path.recordings.map((row) => row.title)).toEqual(["A", "B"]);
    expect(dense.stoppedReason).toBe("no_bridge");
  });

  test("never exceeds the advertised total provider-query budget across fallback phases", async () => {
    const path = twoNodePath();
    let lookups = 0;
    const p = provider({
      A: [["C1", "C1", 0.8], ["C2", "C2", 0.79], ["C3", "C3", 0.78]],
      B: [["D1", "D1", 0.8], ["D2", "D2", 0.79], ["D3", "D3", 0.78]],
      C1: [["X", "X", 0.7]],
      C2: [["Y", "Y", 0.7]],
      C3: [["Z", "Z", 0.7]],
    }, () => { lookups++; });
    const maxQueries = 6;
    const dense = await densifyGradientRecordingPathWithSubpathFallback(path, 6, p, {
      minBridgeSimilarity: 0.2,
      maxQueries,
    });
    expect(lookups).toBeLessThanOrEqual(maxQueries);
    expect(dense.queryCount).toBeLessThanOrEqual(maxQueries);
  });
});
