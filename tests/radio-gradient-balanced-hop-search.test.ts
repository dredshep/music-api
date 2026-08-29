import { describe, expect, test } from "bun:test";
import { searchBalancedFixedHopPath } from "../src/services/radio-gradient-balanced-hop-search";
import {
  gradientRecording,
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingNeighbor,
  type GradientRecordingNeighborProvider,
} from "../src/services/radio-gradient-recording-path";

function graphProvider(graph: Map<string, Map<string, number>>): GradientRecordingNeighborProvider {
  const nodes = new Map<string, GradientRecording>();
  for (const [key] of graph) {
    const [artist, title] = key.split("|");
    if (!nodes.has(key)) nodes.set(key, gradientRecording(artist!, title!));
  }
  const neighbor = (sourceKey: string, targetKey: string): GradientRecordingNeighbor | null => {
    const similarity = graph.get(sourceKey)?.get(targetKey) ?? graph.get(targetKey)?.get(sourceKey);
    const target = nodes.get(targetKey);
    if (similarity == null || !target) return null;
    return { ...target, similarity, confidence: 1, provider: "synthetic" };
  };
  return {
    async neighbors(recording, limit) {
      const candidates: GradientRecordingNeighbor[] = [];
      for (const target of nodes.values()) {
        if (target.key === recording.key) continue;
        const row = neighbor(recording.key, target.key);
        if (row) candidates.push(row);
      }
      return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    },
    lookupEdge(sourceKey, targetKey) {
      return neighbor(sourceKey, targetKey);
    },
  };
}

function connect(graph: Map<string, Map<string, number>>, a: GradientRecording, b: GradientRecording, similarity: number) {
  const bucket = graph.get(a.key) ?? new Map<string, number>();
  bucket.set(b.key, similarity);
  graph.set(a.key, bucket);
}

function maxShare(similarities: number[]) {
  const costs = similarities.map((similarity) => gradientRecordingEdgeCost(similarity, 1));
  const total = costs.reduce((sum, value) => sum + value, 0);
  return Math.max(...costs) / total;
}

describe("balanced exact-hop Gradient search", () => {
  test("uses exactly nine transitions and prefers a distributed journey over a shortcut cliff", async () => {
    const start = gradientRecording("Poppy", "Girls In Bikinis");
    const end = gradientRecording("Marduk", "Panzer Division Marduk");
    const balanced = Array.from({ length: 8 }, (_, index) => gradientRecording(`Bridge${index + 1}`, `Track${index + 1}`));
    const graph = new Map<string, Map<string, number>>();
    const all = [start, ...balanced, end];
    for (const row of all) graph.set(row.key, new Map());

    // A proper ten-track trajectory: every hop carries comparable distance.
    for (let index = 0; index < all.length - 1; index++) connect(graph, all[index]!, all[index + 1]!, 0.56);

    // Tempting comfort-zone shortcuts create the old shape: several cheap hops,
    // then one severe transition. Exact-hop scoring should not prefer them.
    const comfort1 = gradientRecording("Poppy", "Comfort 1");
    const comfort2 = gradientRecording("Poppy", "Comfort 2");
    const cliff = gradientRecording("Metal", "Cliff Landing");
    for (const row of [comfort1, comfort2, cliff]) graph.set(row.key, new Map());
    connect(graph, start, comfort1, 0.96);
    connect(graph, comfort1, comfort2, 0.95);
    connect(graph, comfort2, cliff, 0.08);
    connect(graph, cliff, end, 0.70);

    const result = await searchBalancedFixedHopPath(start, end, graphProvider(graph), {
      requestedLength: 10,
      maxQueries: 48,
      beamWidth: 18,
      neighborLimit: 48,
      endpointArtists: ["Poppy", "Marduk"],
    });

    expect(result.path).not.toBeNull();
    expect(result.path!.recordings).toHaveLength(10);
    expect(result.path!.recordings[0]!.key).toBe(start.key);
    expect(result.path!.recordings.at(-1)!.key).toBe(end.key);
    const similarities = result.path!.edges.map((edge) => edge.similarity);
    expect(maxShare(similarities)).toBeLessThan(0.16);
    expect(result.path!.recordings.some((row) => row.title === "Comfort 2")).toBe(false);
  });
});
