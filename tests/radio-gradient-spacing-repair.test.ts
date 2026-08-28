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

describe("Gradient fixed-length spacing repair", () => {
  test("splits a dominant gap and reclaims a slot from repeated endpoint territory", async () => {
    const p1 = gradientRecording("Poppy", "Girls in Bikinis");
    const p2 = gradientRecording("Poppy", "Chic Chick");
    const grimes = gradientRecording("Grimes featuring HANA", "We Appreciate Power");
    const p3 = gradientRecording("Poppy", "X");
    const slipknot = gradientRecording("Slipknot", "Psychosocial");
    const lamb = gradientRecording("Lamb of God", "Redneck");
    const slayer = gradientRecording("Slayer", "Raining Blood");
    const satyricon = gradientRecording("Satyricon", "K.I.N.G");
    const mayhem = gradientRecording("Mayhem", "Freezing Moon");
    const taake = gradientRecording("Taake", "Myr");
    const bridge = gradientRecording("Bridge Artist", "Bridge Song");

    const original = makePath(
      [p1, p2, grimes, p3, slipknot, lamb, slayer, satyricon, mayhem, taake],
      [0.9, 0.85, 0.85, 0.12, 0.7, 0.8, 0.8, 0.8, 0.7],
    );
    const before = gradientMaxEdgeShare(original);
    expect(before).toBeGreaterThan(0.3);

    const graph = provider({
      [p3.key]: [[bridge, 0.68]],
      [slipknot.key]: [[bridge, 0.66]],
      // After inserting the bridge, reclaim Chic Chick from the densely packed
      // Poppy cluster using a real validated Girls in Bikinis -> Grimes edge.
      [p1.key]: [[grimes, 0.82]],
    });
    const result = await densifyGradientRecordingPathWithSubpathFallback(original, 10, graph, {
      maxQueries: 80,
      endpointArtists: ["Poppy", "Taake"],
    });

    expect(result.path.recordings).toHaveLength(10);
    expect(result.path.recordings.map((row) => row.title)).toContain("Bridge Song");
    expect(result.path.recordings.map((row) => row.title)).not.toContain("Chic Chick");
    expect(result.operations.some((operation) => operation.inserted.includes("Bridge Song"))).toBe(true);
    expect(gradientMaxEdgeShare(result.path)).toBeLessThan(before);
    expect(result.queryCount).toBeGreaterThan(0);
  });

  test("does not rewrite an exact-length route when no validated bridge exists", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => gradientRecording(`Artist ${index}`, `Track ${index}`));
    const original = makePath(rows, [0.9, 0.9, 0.9, 0.1, 0.8, 0.8, 0.8, 0.8, 0.8]);
    const result = await densifyGradientRecordingPathWithSubpathFallback(original, 10, provider({}), {
      maxQueries: 40,
      endpointArtists: ["Artist 0", "Artist 9"],
    });

    expect(result.path.recordings.map((row) => row.key)).toEqual(original.recordings.map((row) => row.key));
    expect(result.operations).toHaveLength(0);
    expect(result.stoppedReason).toBe("requested_length");
  });

  test("leaves an already balanced route untouched without provider work", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => gradientRecording(`Artist ${index}`, `Track ${index}`));
    const original = makePath(rows, Array(9).fill(0.7));
    let calls = 0;
    const p: GradientRecordingNeighborProvider = {
      async neighbors() {
        calls++;
        return [];
      },
    };
    const result = await densifyGradientRecordingPathWithSubpathFallback(original, 10, p, {
      maxQueries: 40,
    });

    expect(result.path.recordings.map((row) => row.key)).toEqual(original.recordings.map((row) => row.key));
    expect(result.operations).toHaveLength(0);
    expect(result.queryCount).toBe(0);
    expect(calls).toBe(0);
  });
});
