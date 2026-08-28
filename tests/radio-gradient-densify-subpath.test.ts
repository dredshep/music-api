import { describe, expect, test } from "bun:test";
import { densifyGradientRecordingPathWithSubpathFallback } from "../src/services/radio-gradient-densify-subpath";
import {
  gradientRecording,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
} from "../src/services/radio-gradient-recording-path";

function provider(graph: Record<string, Array<[string, string, number]>>): GradientRecordingNeighborProvider {
  return {
    async neighbors(recording) {
      return (graph[recording.title] ?? []).map(([artist, title, similarity]) => ({
        ...gradientRecording(artist, title),
        similarity,
        confidence: 1,
        provider: "test",
      }));
    },
  };
}

describe("Gradient multi-hop densification fallback", () => {
  test("inserts C and D when no single common neighbor bridges A and B", async () => {
    const a = gradientRecording("A", "A");
    const b = gradientRecording("B", "B");
    const path: GradientRecordingPath = {
      recordings: [a, b],
      edges: [{ from: a, to: b, similarity: 0.15, confidence: 1, provider: "weak-direct" }],
      cost: 1,
      queryCount: 0,
      nodesVisited: 2,
      forwardFrontierSize: 0,
      backwardFrontierSize: 0,
      intersection: null,
    };
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
    const a = gradientRecording("A", "A");
    const b = gradientRecording("B", "B");
    const path: GradientRecordingPath = {
      recordings: [a, b],
      edges: [{ from: a, to: b, similarity: 0.15, confidence: 1, provider: "weak-direct" }],
      cost: 1,
      queryCount: 0,
      nodesVisited: 2,
      forwardFrontierSize: 0,
      backwardFrontierSize: 0,
      intersection: null,
    };
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
});
