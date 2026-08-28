import { describe, expect, test } from "bun:test";
import {
  compressGradientRecordingPath,
  densifyGradientRecordingPath,
  discoverGradientRecordingPath,
  gradientFamiliarityTarget,
  gradientRecording,
  gradientRecordingEdgeCost,
  refinePathNovelty,
  type GradientRecording,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "../src/services/radio-gradient-recording-path";
import { budgetTotalUsed, createRouteBudget } from "../src/services/radio-gradient-budget";

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

function makePath(artists: string[]): GradientRecordingPath {
  const recordings = artists.map((a) => gradientRecording(a, `${a}-song`));
  const edges: GradientRecordingPathEdge[] = [];
  for (let i = 1; i < recordings.length; i++) {
    edges.push({
      from: recordings[i - 1]!, to: recordings[i]!,
      similarity: 0.7, confidence: 0.9, provider: "test",
    });
  }
  return {
    recordings, edges, cost: edges.reduce((s, e) => s + gradientRecordingEdgeCost(e.similarity, e.confidence), 0),
    queryCount: 0, nodesVisited: recordings.length, forwardFrontierSize: 0, backwardFrontierSize: 0, intersection: null,
  };
}

describe("path compression", () => {
  function connectedProvider(artists: string[]): GradientRecordingNeighborProvider {
    const recs = artists.map((a) => gradientRecording(a, `${a}-song`));
    return {
      async neighbors(recording) {
        return recs
          .filter((r) => r.key !== recording.key)
          .map((r) => ({ ...r, similarity: 0.5, confidence: 0.9, provider: "synthetic" }));
      },
    };
  }

  test("overlong path compresses safely to exact requested length", async () => {
    const artists = ["A", "B", "C", "D", "E", "F", "G"];
    const path = makePath(artists);
    const p = connectedProvider(artists);
    const result = await compressGradientRecordingPath(path, 4, p);
    expect(result.compressed).toBe(true);
    expect(result.path.recordings).toHaveLength(4);
    expect(result.removedCount).toBe(3);
  });

  test("exact endpoints survive compression", async () => {
    const artists = ["Start", "M1", "M2", "M3", "End"];
    const path = makePath(artists);
    const p = connectedProvider(artists);
    const result = await compressGradientRecordingPath(path, 2, p);
    expect(result.path.recordings[0]!.artist).toBe("Start");
    expect(result.path.recordings.at(-1)!.artist).toBe("End");
  });

  test("mandatory waypoints survive compression", async () => {
    const artists = ["A", "B", "C", "D", "E"];
    const path = makePath(artists);
    const p = connectedProvider(artists);
    const mandatory = new Set([gradientRecording("C", "C-song").key]);
    const result = await compressGradientRecordingPath(path, 3, p, mandatory);
    expect(result.path.recordings).toHaveLength(3);
    expect(result.path.recordings.some((r) => r.artist === "C")).toBe(true);
    expect(result.path.recordings[0]!.artist).toBe("A");
    expect(result.path.recordings.at(-1)!.artist).toBe("E");
  });

  test("every resulting skip edge comes from actual provider evidence", async () => {
    const artists = ["A", "B", "C", "D", "E"];
    const queriedKeys = new Set<string>();
    const p: GradientRecordingNeighborProvider = {
      async neighbors(recording) {
        queriedKeys.add(recording.key);
        const others = artists.filter((a) => key(a, `${a}-song`) !== recording.key);
        return others.map((a) => ({
          ...gradientRecording(a, `${a}-song`), similarity: 0.45, confidence: 0.85, provider: "validated",
        }));
      },
    };
    const path = makePath(artists);
    const result = await compressGradientRecordingPath(path, 3, p);
    expect(result.compressed).toBe(true);
    expect(queriedKeys.size).toBeGreaterThan(0);
    for (const edge of result.path.edges) {
      const isOriginalConsecutive = artists.some((a, i) =>
        i < artists.length - 1
        && edge.from.key === key(a, `${a}-song`)
        && edge.to.key === key(artists[i + 1]!, `${artists[i + 1]!}-song`),
      );
      if (!isOriginalConsecutive) {
        expect(edge.similarity).toBe(0.45);
        expect(edge.provider).toBe("validated");
      }
    }
  });

  test("compression fails when provider has no skip edge", async () => {
    const path = makePath(["A", "B", "C", "D", "E"]);
    const p = provider({});
    const result = await compressGradientRecordingPath(path, 2, p);
    expect(result.compressed).toBe(false);
    expect(result.partialReason).toBe("no_validated_skip_edge");
    expect(result.path.recordings.length).toBeGreaterThan(2);
  });

  test("compression never calls the provider past the shared query ceiling", async () => {
    const artists = ["A", "B", "C", "D", "E"];
    const path = makePath(artists);
    let providerCalls = 0;
    const p: GradientRecordingNeighborProvider = {
      async neighbors(recording) {
        providerCalls++;
        return artists
          .filter((a) => key(a, `${a}-song`) !== recording.key)
          .map((a) => ({ ...gradientRecording(a, `${a}-song`), similarity: 0.5, confidence: 0.9, provider: "synthetic" }));
      },
    };
    const budget = createRouteBudget(2, 60_000);
    budget.initialRecordingQueries = 1;

    const result = await compressGradientRecordingPath(path, 2, p, undefined, budget);

    expect(providerCalls).toBe(1);
    expect(budgetTotalUsed(budget)).toBe(2);
    expect(budgetTotalUsed(budget)).toBeLessThanOrEqual(budget.maxQueries);
    expect(result.compressed).toBe(false);
    expect(result.partialReason).toBe("global_budget_exhausted");
  });

  test("path already at requested length is unchanged", async () => {
    const path = makePath(["A", "B", "C"]);
    const p = provider({});
    const result = await compressGradientRecordingPath(path, 3, p);
    expect(result.compressed).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.path.recordings).toHaveLength(3);
  });
});

describe("novelty refinement", () => {
  function familiarityMap(map: Record<string, number>): (r: GradientRecording) => number | null {
    return (r) => map[r.key] ?? null;
  }

  test("replaces overfamiliar central recording when a novel bridge exists", async () => {
    const path = makePath(["A", "B", "Familiar", "D", "E"]);
    const novelKey = key("Novel", "Novel-song");
    const familiarKey = key("Familiar", "Familiar-song");
    const p = provider({
      [key("B", "B-song")]: [["Novel", "Novel-song", 0.6]],
      [key("D", "D-song")]: [["Novel", "Novel-song", 0.6]],
    });
    const fam = familiarityMap({ [familiarKey]: 0.95, [novelKey]: 0.1 });
    const result = await refinePathNovelty(path, p, { familiarity: fam });
    expect(result.replacements).toBe(1);
    expect(result.path.recordings[2]!.artist).toBe("Novel");
    expect(result.path.edges[1]!.to.key).toBe(novelKey);
    expect(result.path.edges[2]!.from.key).toBe(novelKey);
  });

  test("does not replace endpoints or mandatory waypoints", async () => {
    const path = makePath(["A", "B", "Waypoint", "D", "E"]);
    const waypointKey = key("Waypoint", "Waypoint-song");
    const p = provider({
      [key("B", "B-song")]: [["Alt", "Alt-song", 0.8]],
      [key("D", "D-song")]: [["Alt", "Alt-song", 0.8]],
    });
    const fam = familiarityMap({ [waypointKey]: 0.99 });
    const mandatory = new Set([waypointKey]);
    const result = await refinePathNovelty(path, p, { familiarity: fam, mandatoryKeys: mandatory });
    expect(result.replacements).toBe(0);
    expect(result.path.recordings[2]!.artist).toBe("Waypoint");
  });

  test("does not replace when no novel bridge maintains transition quality", async () => {
    const path = makePath(["A", "B", "Familiar", "D", "E"]);
    const familiarKey = key("Familiar", "Familiar-song");
    const p = provider({
      [key("B", "B-song")]: [["Bad", "Bad-song", 0.05]],
      [key("D", "D-song")]: [["Bad", "Bad-song", 0.05]],
    });
    const fam = familiarityMap({ [familiarKey]: 0.95 });
    const result = await refinePathNovelty(path, p, { familiarity: fam });
    expect(result.replacements).toBe(0);
    expect(result.path.recordings[2]!.artist).toBe("Familiar");
  });

  test("leaves recordings near endpoints untouched regardless of familiarity", async () => {
    const names = ["A", "TooClose", "C", "D", "E", "F", "G", "H", "I", "J"];
    const path = makePath(names);
    const tooCloseKey = key("TooClose", "TooClose-song");
    const p = provider({
      [key("A", "A-song")]: [["Alt", "Alt-song", 0.9]],
      [key("C", "C-song")]: [["Alt", "Alt-song", 0.9]],
    });
    const fam = familiarityMap({ [tooCloseKey]: 0.99 });
    const result = await refinePathNovelty(path, p, { familiarity: fam });
    expect(result.path.recordings[1]!.artist).toBe("TooClose");
  });

  test("preserves all edge invariants after replacement", async () => {
    const path = makePath(["A", "B", "Old", "D", "E"]);
    const p = provider({
      [key("B", "B-song")]: [["New", "New-song", 0.7]],
      [key("D", "D-song")]: [["New", "New-song", 0.65]],
    });
    const fam = familiarityMap({ [key("Old", "Old-song")]: 0.95, [key("New", "New-song")]: 0.1 });
    const result = await refinePathNovelty(path, p, { familiarity: fam });
    expect(result.replacements).toBe(1);
    for (let i = 0; i < result.path.edges.length; i++) {
      expect(result.path.edges[i]!.from.key).toBe(result.path.recordings[i]!.key);
      expect(result.path.edges[i]!.to.key).toBe(result.path.recordings[i + 1]!.key);
      expect(result.path.edges[i]!.similarity).toBeGreaterThan(0);
    }
  });
});
