import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";
import { searchBalancedFixedHopPath } from "../src/services/radio-gradient-balanced-hop-search";
import {
  clearMinimaxSolutionCache,
  searchCachedBalancedFixedHopPath,
} from "../src/services/radio-gradient-cached-minimax-hop-search";
import {
  gradientRecording,
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingNeighborProvider,
} from "../src/services/radio-gradient-recording-path";

const dbPath = `/tmp/music-api-gradient-cached-minimax-${Date.now()}.sqlite`;

beforeAll(() => {
  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = "test-test-test-test-test-test-test-test";
  process.env.NAVIDROME_USERNAME = "test";
  process.env.NAVIDROME_PASSWORD = "test";
  process.env.LASTFM_API_KEY = "test";
  process.env.LASTFM_USERNAME = "test";
  resetConfigForTests();
  initDatabase();
});

afterAll(() => { try { unlinkSync(dbPath); } catch {} });

beforeEach(() => {
  getDb().exec("DELETE FROM recording_similarity_edges; DELETE FROM recording_similarity_fetches; DELETE FROM recording_similarity_nodes; DELETE FROM track_audio_analysis;");
  clearMinimaxSolutionCache();
});

function insertNode(recording: GradientRecording) {
  getDb().query(`INSERT INTO recording_similarity_nodes
      (canonical_key,artist,title,recording_mbid,updated_at)
      VALUES (?,?,?,?,?)`)
    .run(recording.key, recording.artist, recording.title, recording.mbid, new Date().toISOString());
}

function insertEdge(from: GradientRecording, to: GradientRecording, similarity: number, confidence = 1, provider = "synthetic_cache") {
  getDb().query(`INSERT INTO recording_similarity_edges
      (source_key,target_key,provider,similarity,confidence,directionality,metadata_json,retrieved_at)
      VALUES (?,?,?, ?,?,'observed',NULL,?)`)
    .run(from.key, to.key, provider, similarity, confidence, new Date().toISOString());
}

function insertAcousticAnalysis(recording: GradientRecording, overrides: Record<string, unknown> = {}) {
  const key = `${recording.artist.toLowerCase()}|${recording.title.toLowerCase()}`;
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO track_audio_analysis
      (canonical_key,status,analysis_version,bpm,musical_key,mode,loudness,energy,timbre_json,intro_json,outro_json,created_at,updated_at)
      VALUES (?,'ready',1,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      key,
      overrides.bpm ?? 120, overrides.key ?? "C", overrides.mode ?? "major",
      overrides.loudness ?? -10, overrides.energy ?? 0.6,
      overrides.timbre ? JSON.stringify(overrides.timbre) : null,
      overrides.intro ? JSON.stringify(overrides.intro) : null,
      overrides.outro ? JSON.stringify(overrides.outro) : null,
      now, now,
    );
}

function maxShare(similarities: Array<{ similarity: number; confidence: number }>) {
  const costs = similarities.map((edge) => gradientRecordingEdgeCost(edge.similarity, edge.confidence));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return Math.max(...costs) / total;
}

function maxEdgeCost(edges: Array<{ similarity: number; confidence: number }>) {
  return Math.max(...edges.map((e) => gradientRecordingEdgeCost(e.similarity, e.confidence)));
}

const noLiveProvider: GradientRecordingNeighborProvider = {
  async neighbors() { return []; },
};

describe("cached exact-hop minimax Gradient search", () => {
  test("finds the smooth 10-track path even when useful edges sit below a top-48 neighborhood", async () => {
    const start = gradientRecording("Poppy", "Girls In Bikinis");
    const end = gradientRecording("Marduk", "Panzer Division Marduk");
    const balanced = Array.from({ length: 8 }, (_, index) => gradientRecording(`Bridge ${index + 1}`, `Track ${index + 1}`));
    const clustered = Array.from({ length: 8 }, (_, index) => gradientRecording(`Cluster ${index + 1}`, `Track ${index + 1}`));
    const decoys = Array.from({ length: 64 }, (_, index) => gradientRecording(`Decoy ${index + 1}`, `Dead End ${index + 1}`));
    for (const recording of [start, end, ...balanced, ...clustered, ...decoys]) insertNode(recording);

    const smooth = [start, ...balanced, end];
    for (let index = 0; index < smooth.length - 1; index++) {
      insertEdge(smooth[index]!, smooth[index + 1]!, 0.45);
    }

    const cheapCliff = [start, ...clustered, end];
    for (let index = 0; index < cheapCliff.length - 1; index++) {
      insertEdge(cheapCliff[index]!, cheapCliff[index + 1]!, index === 4 ? 0.08 : 0.97);
    }

    for (const decoy of decoys) insertEdge(balanced[2]!, decoy, 0.90);

    const result = await searchBalancedFixedHopPath(start, end, noLiveProvider, {
      requestedLength: 10,
      minSimilarity: 0.08,
      endpointArtists: ["Poppy", "Marduk"],
    });

    expect(result.path).not.toBeNull();
    expect(result.queryCount).toBe(0);
    expect(result.path!.recordings).toHaveLength(10);
    expect(result.path!.recordings[0]!.key).toBe(start.key);
    expect(result.path!.recordings.at(-1)!.key).toBe(end.key);
    expect(result.path!.recordings.map((row) => row.artist)).toEqual([
      "Poppy",
      ...balanced.map((row) => row.artist),
      "Marduk",
    ]);
    expect(maxShare(result.path!.edges)).toBeLessThan(0.13);
  });

  test("exact endpoint tracks are preserved", () => {
    const start = gradientRecording("Artist A", "Track A");
    const mid = gradientRecording("Artist B", "Track B");
    const end = gradientRecording("Artist C", "Track C");
    for (const r of [start, mid, end]) insertNode(r);
    insertEdge(start, mid, 0.5);
    insertEdge(mid, end, 0.5);

    const result = searchCachedBalancedFixedHopPath(start, end, { requestedLength: 3 });
    expect(result.path).not.toBeNull();
    expect(result.path!.recordings[0]).toEqual(start);
    expect(result.path!.recordings.at(-1)).toEqual(end);
  });

  test("exact requested cardinality is enforced", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => gradientRecording(`Artist ${i}`, `Track ${i}`));
    for (const n of nodes) insertNode(n);
    for (let i = 0; i < nodes.length - 1; i++) insertEdge(nodes[i]!, nodes[i + 1]!, 0.5);

    const result = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[5]!, { requestedLength: 6 });
    expect(result.path).not.toBeNull();
    expect(result.path!.recordings).toHaveLength(6);
    expect(result.path!.edges).toHaveLength(5);
  });

  test("minimax prefers balanced route over cheap-cluster + giant cliff", () => {
    const start = gradientRecording("Start", "Begin");
    const end = gradientRecording("End", "Finish");
    const balanced = Array.from({ length: 3 }, (_, i) => gradientRecording(`Balanced ${i}`, `Mid ${i}`));
    const cheap = Array.from({ length: 3 }, (_, i) => gradientRecording(`Cheap ${i}`, `Near ${i}`));
    for (const r of [start, end, ...balanced, ...cheap]) insertNode(r);

    const smoothPath = [start, ...balanced, end];
    for (let i = 0; i < smoothPath.length - 1; i++) insertEdge(smoothPath[i]!, smoothPath[i + 1]!, 0.4);

    const cheapPath = [start, ...cheap, end];
    for (let i = 0; i < cheapPath.length - 1; i++) {
      insertEdge(cheapPath[i]!, cheapPath[i + 1]!, i === 2 ? 0.06 : 0.95);
    }

    const result = searchCachedBalancedFixedHopPath(start, end, { requestedLength: 5, minSimilarity: 0.05 });
    expect(result.path).not.toBeNull();
    const smoothMax = maxEdgeCost(result.path!.edges);
    const cliffCost = gradientRecordingEdgeCost(0.06, 1);
    expect(smoothMax).toBeLessThan(cliffCost);
  });

  test("no duplicate recordings in the result", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => gradientRecording(`Artist ${i}`, `Track ${i}`));
    for (const n of nodes) insertNode(n);
    for (let i = 0; i < nodes.length - 1; i++) {
      insertEdge(nodes[i]!, nodes[i + 1]!, 0.5);
      if (i + 2 < nodes.length) insertEdge(nodes[i]!, nodes[i + 2]!, 0.3);
    }
    insertEdge(nodes[0]!, nodes[3]!, 0.2);

    const result = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[5]!, { requestedLength: 6 });
    expect(result.path).not.toBeNull();
    const keys = result.path!.recordings.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("cached collaborative edges are traversable bidirectionally", () => {
    const a = gradientRecording("Alpha", "Song A");
    const b = gradientRecording("Beta", "Song B");
    const c = gradientRecording("Gamma", "Song C");
    for (const r of [a, b, c]) insertNode(r);
    // Only insert edges in one direction — bidirectional expansion should still find paths
    insertEdge(a, b, 0.6);
    insertEdge(c, b, 0.6);

    const forward = searchCachedBalancedFixedHopPath(a, c, { requestedLength: 3 });
    expect(forward.path).not.toBeNull();
    expect(forward.path!.recordings.map((r) => r.key)).toEqual([a.key, b.key, c.key]);

    clearMinimaxSolutionCache();

    const reverse = searchCachedBalancedFixedHopPath(c, a, { requestedLength: 3 });
    expect(reverse.path).not.toBeNull();
    expect(reverse.path!.recordings.map((r) => r.key)).toEqual([c.key, b.key, a.key]);
  });

  test("catastrophic acoustic cached edge is rejected", () => {
    const a = gradientRecording("Calm", "Ambient Piece");
    const b = gradientRecording("Harsh", "Noise Blast");
    const c = gradientRecording("Mid", "Bridge Song");
    for (const r of [a, b, c]) insertNode(r);

    // a→b has high similarity but catastrophic acoustic mismatch
    insertEdge(a, b, 0.9);
    insertEdge(b, c, 0.9);
    // Safe alternative exists
    insertEdge(a, c, 0.4);

    // Insert acoustic analysis that creates a catastrophic transition for a→b
    insertAcousticAnalysis(a, {
      bpm: 60, energy: 0.05, loudness: -30,
      timbre: { spectral_centroid_mean: 200, spectral_centroid_std: 50, zero_crossing_rate_mean: 0.01 },
      intro: { rms: 0.01 },
      outro: { rms: 0.01 },
    });
    insertAcousticAnalysis(b, {
      bpm: 200, energy: 0.99, loudness: -3,
      timbre: { spectral_centroid_mean: 8000, spectral_centroid_std: 5000, zero_crossing_rate_mean: 0.45 },
      intro: { rms: 0.9 },
      outro: { rms: 0.9 },
    });

    const result = searchCachedBalancedFixedHopPath(a, c, { requestedLength: 2 });
    expect(result.path).not.toBeNull();
    // Should use direct a→c edge, avoiding the catastrophic a→b transition
    expect(result.path!.recordings).toHaveLength(2);
    expect(result.path!.recordings[0]!.key).toBe(a.key);
    expect(result.path!.recordings[1]!.key).toBe(c.key);
  });

  test("accepted zero-query cached path is retained via pathChanged semantics", async () => {
    const start = gradientRecording("Start", "First");
    const mid = gradientRecording("Middle", "Second");
    const end = gradientRecording("End", "Third");
    for (const r of [start, mid, end]) insertNode(r);
    insertEdge(start, mid, 0.5);
    insertEdge(mid, end, 0.5);

    const result = await searchBalancedFixedHopPath(start, end, noLiveProvider, {
      requestedLength: 3,
    });

    expect(result.path).not.toBeNull();
    expect(result.queryCount).toBe(0);
    expect(result.path!.recordings).toHaveLength(3);
    expect(result.path!.recordings[0]!.key).toBe(start.key);
    expect(result.path!.recordings[1]!.key).toBe(mid.key);
    expect(result.path!.recordings.at(-1)!.key).toBe(end.key);
  });

  test("optimization does not change the winning minimax solution on synthetic graphs", () => {
    const start = gradientRecording("S", "Start");
    const end = gradientRecording("E", "End");
    const path1Mid = Array.from({ length: 4 }, (_, i) => gradientRecording(`P1-${i}`, `Track ${i}`));
    const path2Mid = Array.from({ length: 4 }, (_, i) => gradientRecording(`P2-${i}`, `Track ${i}`));
    for (const r of [start, end, ...path1Mid, ...path2Mid]) insertNode(r);

    // Path 1: uniform similarity 0.40 → all edges equal cost
    const chain1 = [start, ...path1Mid, end];
    for (let i = 0; i < chain1.length - 1; i++) insertEdge(chain1[i]!, chain1[i + 1]!, 0.40);

    // Path 2: most edges very cheap (0.95) but one terrible edge (0.10)
    const chain2 = [start, ...path2Mid, end];
    for (let i = 0; i < chain2.length - 1; i++) {
      insertEdge(chain2[i]!, chain2[i + 1]!, i === 2 ? 0.10 : 0.95);
    }

    const result = searchCachedBalancedFixedHopPath(start, end, { requestedLength: 6, minSimilarity: 0.08 });
    expect(result.path).not.toBeNull();

    // Minimax must pick path 1 (uniform 0.40) over path 2 (one 0.10 bottleneck)
    const path1MaxCost = gradientRecordingEdgeCost(0.40, 1);
    const path2MaxCost = gradientRecordingEdgeCost(0.10, 1);
    expect(maxEdgeCost(result.path!.edges)).toBeCloseTo(path1MaxCost, 4);
    expect(maxEdgeCost(result.path!.edges)).toBeLessThan(path2MaxCost);
  });

  test("returns null when no path exists within hop constraint", () => {
    const start = gradientRecording("Isolated A", "Song A");
    const end = gradientRecording("Isolated B", "Song B");
    for (const r of [start, end]) insertNode(r);
    // No edges at all

    const result = searchCachedBalancedFixedHopPath(start, end, { requestedLength: 3 });
    expect(result.path).toBeNull();
  });

  test("solution cache returns same result on repeated identical search", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => gradientRecording(`Node ${i}`, `Track ${i}`));
    for (const n of nodes) insertNode(n);
    for (let i = 0; i < nodes.length - 1; i++) insertEdge(nodes[i]!, nodes[i + 1]!, 0.5);

    const first = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[4]!, { requestedLength: 5 });
    const second = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[4]!, { requestedLength: 5 });

    expect(first.path).not.toBeNull();
    expect(second.path).not.toBeNull();
    expect(second.path!.recordings.map((r) => r.key)).toEqual(first.path!.recordings.map((r) => r.key));
    expect(second.path!.cost).toBe(first.path!.cost);
  });

  test("solution cache invalidates after graph mutation", () => {
    const nodes = Array.from({ length: 4 }, (_, i) => gradientRecording(`Cache ${i}`, `Song ${i}`));
    for (const n of nodes) insertNode(n);
    insertEdge(nodes[0]!, nodes[1]!, 0.5);
    insertEdge(nodes[1]!, nodes[2]!, 0.5);
    insertEdge(nodes[2]!, nodes[3]!, 0.5);

    const first = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[3]!, { requestedLength: 4 });
    expect(first.path).not.toBeNull();

    // Mutate graph: add a new node with its own edges
    const shortcut = gradientRecording("Shortcut", "Direct");
    insertNode(shortcut);
    insertEdge(nodes[0]!, shortcut, 0.8);
    insertEdge(shortcut, nodes[2]!, 0.8);

    const second = searchCachedBalancedFixedHopPath(nodes[0]!, nodes[3]!, { requestedLength: 4 });
    expect(second.path).not.toBeNull();
    expect(second.graphNodes).toBeGreaterThan(first.graphNodes);
  });

  test("endpoint-artist blocking suppresses endpoint artists in the middle", () => {
    const start = gradientRecording("Poppy", "Song A");
    const mid1 = gradientRecording("Poppy", "Song B");
    const mid2 = gradientRecording("Other", "Song C");
    const mid3 = gradientRecording("Another", "Song D");
    const end = gradientRecording("Marduk", "Song E");
    for (const r of [start, mid1, mid2, mid3, end]) insertNode(r);

    // Path through Poppy in the middle (should be blocked)
    insertEdge(start, mid1, 0.9);
    insertEdge(mid1, mid3, 0.9);
    insertEdge(mid3, end, 0.9);
    // Alternative path avoiding Poppy in the middle
    insertEdge(start, mid2, 0.5);
    insertEdge(mid2, mid3, 0.5);

    const result = searchCachedBalancedFixedHopPath(start, end, {
      requestedLength: 4,
      endpointArtists: ["Poppy", "Marduk"],
    });
    expect(result.path).not.toBeNull();
    const middleArtists = result.path!.recordings.slice(1, -1).map((r) => r.artist.toLowerCase());
    expect(middleArtists).not.toContain("poppy");
  });

  test("multi-provider edges get confidence boost", () => {
    const a = gradientRecording("Multi A", "Song A");
    const b = gradientRecording("Multi B", "Song B");
    const c = gradientRecording("Multi C", "Song C");
    const d = gradientRecording("Multi D", "Song D");
    for (const r of [a, b, c, d]) insertNode(r);

    // a→b has multiple providers (confidence boost)
    insertEdge(a, b, 0.4, 0.6, "lastfm");
    insertEdge(a, b, 0.35, 0.5, "musicbrainz");
    // a→c has single provider same similarity
    insertEdge(a, c, 0.4, 0.6, "lastfm");
    // Both reach d
    insertEdge(b, d, 0.5);
    insertEdge(c, d, 0.5);

    const result = searchCachedBalancedFixedHopPath(a, d, { requestedLength: 3 });
    expect(result.path).not.toBeNull();
    // Multi-provider edge should be preferred (lower cost due to confidence boost)
    expect(result.path!.recordings[1]!.key).toBe(b.key);
  });
});
