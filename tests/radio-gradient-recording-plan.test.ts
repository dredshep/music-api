import { describe, expect, test } from "bun:test";
import { DEFAULT_RADIO_SETTINGS, type RadioSeedRow } from "../src/db/repositories/radio";
import {
  chainRecordingHops,
  planGradientRecordingRoute,
  type GradientSeedRecordingSources,
} from "../src/services/radio-gradient-recording-plan";
import {
  gradientRecording,
  gradientRecordingEdgeCost,
  searchGradientRecordingPath,
  type GradientRecordingNeighborProvider,
} from "../src/services/radio-gradient-recording-path";
import {
  createRouteBudget,
  isBudgetExhausted,
  budgetTotalUsed,
} from "../src/services/radio-gradient-budget";

function seed(input: Partial<RadioSeedRow> & Pick<RadioSeedRow, "id" | "seed_type" | "label" | "position">): RadioSeedRow {
  return {
    station_id: "station",
    entity_id: null,
    artist: null,
    title: null,
    weight: 1,
    metadata_json: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

const sources: GradientSeedRecordingSources = {
  async artistTracks(artist) {
    if (artist === "A") return [
      { artist, title: "A bright", weight: 1 },
      { artist, title: "A bridge", weight: 0.8 },
    ];
    if (artist === "B") return [
      { artist, title: "B bridge", weight: 0.9 },
      { artist, title: "B other", weight: 1 },
    ];
    if (artist === "C") return [{ artist, title: "C end", weight: 1 }];
    return [];
  },
  async albumTracks() { return []; },
  async genreTracks() { return []; },
};

function graphProvider(graph: Record<string, Array<[string, string, number]>>): GradientRecordingNeighborProvider {
  return {
    async neighbors(recording) {
      return (graph[recording.key] ?? []).map(([artist, title, similarity]) => ({
        ...gradientRecording(artist, title), similarity, confidence: 1, provider: "synthetic",
      }));
    },
  };
}

function settings() {
  return {
    ...DEFAULT_RADIO_SETTINGS,
    gradientAlgorithm: "geodesic" as const,
    providerWeights: { ...DEFAULT_RADIO_SETTINGS.providerWeights },
    djWeights: { ...DEFAULT_RADIO_SETTINGS.djWeights },
  };
}

describe("Gradient recording waypoint semantics", () => {
  test("artist endpoints are hard artists while the planner chooses the route-fitting recordings", async () => {
    const aBridge = gradientRecording("A", "A bridge");
    const bBridge = gradientRecording("B", "B bridge");
    const middle = gradientRecording("Middle", "m");
    const provider = graphProvider({
      [gradientRecording("A", "A bright").key]: [],
      [aBridge.key]: [["Middle", "m", 0.85]],
      [middle.key]: [["A", "A bridge", 0.85], ["B", "B bridge", 0.85]],
      [bBridge.key]: [["Middle", "m", 0.85]],
      [gradientRecording("B", "B other").key]: [],
    });
    const plan = await planGradientRecordingRoute({
      seeds: [
        seed({ id: "a", seed_type: "artist", artist: "A", label: "A", position: 0 }),
        seed({ id: "b", seed_type: "artist", artist: "B", label: "B", position: 1 }),
      ],
      settings: settings(), requestedLength: 3, provider, sources,
    });

    expect(plan.state).toBe("complete");
    expect(plan.endpointStatus.startSatisfied).toBe(true);
    expect(plan.endpointStatus.endSatisfied).toBe(true);
    expect(plan.recordings[0]!.artist).toBe("A");
    expect(plan.recordings[0]!.title).toBe("A bridge");
    expect(plan.recordings.at(-1)!.artist).toBe("B");
    expect(plan.recordings.at(-1)!.title).toBe("B bridge");
  });

  test("exact track endpoints remain exact recordings", async () => {
    const exactA = gradientRecording("A", "Exact A");
    const exactB = gradientRecording("B", "Exact B");
    const provider = graphProvider({
      [exactA.key]: [["B", "Exact B", 0.7]],
      [exactB.key]: [["A", "Exact A", 0.7]],
    });
    const plan = await planGradientRecordingRoute({
      seeds: [
        seed({ id: "a", seed_type: "track", artist: "A", title: "Exact A", label: "Exact A", position: 0 }),
        seed({ id: "b", seed_type: "track", artist: "B", title: "Exact B", label: "Exact B", position: 1 }),
      ],
      settings: settings(), requestedLength: 2, provider, sources,
    });
    expect(plan.state).toBe("complete");
    expect(plan.recordings[0]!.key).toBe(exactA.key);
    expect(plan.recordings.at(-1)!.key).toBe(exactB.key);
  });

  test("A to B to C uses the same concrete B recording on both connected legs", async () => {
    const a = gradientRecording("A", "A bridge");
    const b = gradientRecording("B", "B bridge");
    const c = gradientRecording("C", "C end");
    const ab = gradientRecording("AB", "ab");
    const bc = gradientRecording("BC", "bc");
    const provider = graphProvider({
      [gradientRecording("A", "A bright").key]: [],
      [a.key]: [["AB", "ab", 0.8]],
      [ab.key]: [["A", "A bridge", 0.8], ["B", "B bridge", 0.8]],
      [b.key]: [["AB", "ab", 0.8], ["BC", "bc", 0.8]],
      [gradientRecording("B", "B other").key]: [],
      [bc.key]: [["B", "B bridge", 0.8], ["C", "C end", 0.8]],
      [c.key]: [["BC", "bc", 0.8]],
    });
    const plan = await planGradientRecordingRoute({
      seeds: [
        seed({ id: "a", seed_type: "artist", artist: "A", label: "A", position: 0 }),
        seed({ id: "b", seed_type: "artist", artist: "B", label: "B", position: 0.4 }),
        seed({ id: "c", seed_type: "artist", artist: "C", label: "C", position: 1 }),
      ],
      settings: settings(), requestedLength: 5, provider, sources,
    });
    expect(plan.state).toBe("complete");
    const bRows = plan.recordings.filter((row) => row.artist === "B");
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.title).toBe("B bridge");
    expect(bRows[0]!.routePosition).toBeCloseTo(0.4, 5);
    expect(plan.segments[0]!.recordings.at(-1)!.key).toBe(b.key);
    expect(plan.segments[1]!.recordings[0]!.key).toBe(b.key);
  });

  test("a disconnected leg is reported partial and its hard endpoint stays unpositioned", { timeout: 15000 }, async () => {
    const a = gradientRecording("A", "A bridge");
    const b = gradientRecording("B", "B bridge");
    const ab = gradientRecording("AB", "ab");
    const provider = graphProvider({
      [a.key]: [["AB", "ab", 0.8]],
      [ab.key]: [["A", "A bridge", 0.8], ["B", "B bridge", 0.8]],
      [b.key]: [["AB", "ab", 0.8]],
      [gradientRecording("C", "C end").key]: [],
    });
    const plan = await planGradientRecordingRoute({
      seeds: [
        seed({ id: "a", seed_type: "artist", artist: "A", label: "A", position: 0 }),
        seed({ id: "b", seed_type: "artist", artist: "B", label: "B", position: 0.5 }),
        seed({ id: "c", seed_type: "artist", artist: "C", label: "C", position: 1 }),
      ],
      settings: settings(), requestedLength: 5, provider, sources,
    });
    expect(plan.state).toBe("partial");
    expect(plan.segments[0]!.connected).toBe(true);
    expect(plan.segments[1]!.connected).toBe(false);
    const c = plan.recordings.find((row) => row.artist === "C")!;
    expect(c.routePosition).toBeNull();
    expect(c.unsupportedWaypoint).toBe(true);
  });
});

describe("Bridge hop recording continuity", () => {
  test("chained hops reuse the exact bridge recording from the previous hop", async () => {
    const aSong = gradientRecording("A", "a-song");
    const mid1 = gradientRecording("Mid", "mid-1");
    const mid2 = gradientRecording("Mid", "mid-2");
    const cSong = gradientRecording("C", "c-song");

    const provider = graphProvider({
      [aSong.key]: [["Mid", "mid-1", 0.8]],
      [mid1.key]: [["A", "a-song", 0.8], ["C", "c-song", 0.7]],
      [mid2.key]: [["C", "c-song", 0.9]],
      [cSong.key]: [["Mid", "mid-1", 0.7], ["Mid", "mid-2", 0.9]],
    });

    const path = await chainRecordingHops(
      [[aSong], [mid1, mid2], [cSong]],
      provider,
      { maxQueries: 64, beamPerSide: 4 },
    );

    expect(path).not.toBeNull();
    for (let i = 0; i < path!.edges.length; i++) {
      expect(path!.edges[i]!.from.key).toBe(path!.recordings[i]!.key);
      expect(path!.edges[i]!.to.key).toBe(path!.recordings[i + 1]!.key);
    }
    const midRecordings = path!.recordings.filter((r) => r.artist === "Mid");
    const uniqueMidKeys = new Set(midRecordings.map((r) => r.key));
    expect(uniqueMidKeys.size).toBe(1);
  });

  test("bridge fails honestly when the selected bridge recording cannot reach the next region", async () => {
    const aSong = gradientRecording("A", "a-song");
    const mid1 = gradientRecording("Mid", "mid-1");
    const mid2 = gradientRecording("Mid", "mid-2");
    const cSong = gradientRecording("C", "c-song");

    const provider = graphProvider({
      [aSong.key]: [["Mid", "mid-1", 0.8]],
      [mid1.key]: [["A", "a-song", 0.8]],
      [mid2.key]: [["C", "c-song", 0.9]],
      [cSong.key]: [["Mid", "mid-2", 0.9]],
    });

    const path = await chainRecordingHops(
      [[aSong], [mid1, mid2], [cSong]],
      provider,
      { maxQueries: 64, beamPerSide: 4 },
    );

    expect(path).toBeNull();
  });

  test("chained path cost uses canonical edge cost rather than similarity*confidence", async () => {
    const a = gradientRecording("A", "a");
    const b = gradientRecording("B", "b");
    const c = gradientRecording("C", "c");
    const provider = graphProvider({
      [a.key]: [["B", "b", 0.8]],
      [b.key]: [["A", "a", 0.8], ["C", "c", 0.7]],
      [c.key]: [["B", "b", 0.7]],
    });

    const path = await chainRecordingHops(
      [[a], [b], [c]],
      provider,
      { maxQueries: 64, beamPerSide: 4 },
    );

    expect(path).not.toBeNull();
    const expectedCost = path!.edges.reduce(
      (sum, e) => sum + gradientRecordingEdgeCost(e.similarity, e.confidence), 0,
    );
    expect(path!.cost).toBeCloseTo(expectedCost, 6);
    expect(path!.cost).not.toBeCloseTo(
      path!.edges.reduce((sum, e) => sum + e.similarity * e.confidence, 0), 1,
    );
  });
});

describe("Global search budget", () => {
  test("searchGradientRecordingPath reports consumed queries even on failure", async () => {
    const a = gradientRecording("A", "a");
    const z = gradientRecording("Z", "z");
    const provider = graphProvider({
      [a.key]: [["X", "x1", 0.5]],
      [gradientRecording("X", "x1").key]: [["A", "a", 0.5], ["X", "x2", 0.5]],
      [gradientRecording("X", "x2").key]: [["X", "x1", 0.5]],
      [z.key]: [],
    });

    const result = await searchGradientRecordingPath([a], [z], provider, { maxQueries: 6, beamPerSide: 2 });
    expect(result.path).toBeNull();
    expect(result.queryCount).toBeGreaterThan(0);
    expect(result.nodesVisited).toBeGreaterThan(0);
  });

  test("chained hops respect an exhausted budget", async () => {
    const a = gradientRecording("A", "a");
    const b = gradientRecording("B", "b");
    const c = gradientRecording("C", "c");
    const provider = graphProvider({
      [a.key]: [["B", "b", 0.8]],
      [b.key]: [["A", "a", 0.8], ["C", "c", 0.7]],
      [c.key]: [["B", "b", 0.7]],
    });

    const budget = createRouteBudget(2, 60_000);
    budget.initialRecordingQueries = 2;
    expect(isBudgetExhausted(budget)).toBe(true);

    const path = await chainRecordingHops(
      [[a], [b], [c]],
      provider,
      { maxQueries: 64, beamPerSide: 4 },
      budget,
    );
    expect(path).toBeNull();
  });

  test("plan exposes budget snapshot with all tracked work categories", async () => {
    const a = gradientRecording("A", "A bridge");
    const b = gradientRecording("B", "B bridge");
    const middle = gradientRecording("Middle", "m");
    const provider = graphProvider({
      [gradientRecording("A", "A bright").key]: [],
      [a.key]: [["Middle", "m", 0.85]],
      [middle.key]: [["A", "A bridge", 0.85], ["B", "B bridge", 0.85]],
      [b.key]: [["Middle", "m", 0.85]],
      [gradientRecording("B", "B other").key]: [],
    });
    const plan = await planGradientRecordingRoute({
      seeds: [
        seed({ id: "a", seed_type: "artist", artist: "A", label: "A", position: 0 }),
        seed({ id: "b", seed_type: "artist", artist: "B", label: "B", position: 1 }),
      ],
      settings: settings(), requestedLength: 3, provider, sources,
    });

    expect(plan.budget).not.toBeNull();
    expect(plan.budget!.maxQueries).toBeGreaterThan(0);
    expect(plan.budget!.totalUsed).toBeGreaterThanOrEqual(0);
    expect(plan.budget!.elapsedMs).toBeGreaterThan(0);
    expect(typeof plan.budget!.initialRecordingQueries).toBe("number");
    expect(typeof plan.budget!.densificationQueries).toBe("number");
    expect(typeof plan.budget!.deadlineExhausted).toBe("boolean");
    expect(typeof plan.budget!.budgetExhausted).toBe("boolean");
  });
});
