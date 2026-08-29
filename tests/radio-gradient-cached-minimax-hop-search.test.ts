import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";
import { searchBalancedFixedHopPath } from "../src/services/radio-gradient-balanced-hop-search";
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
});

function insertNode(recording: GradientRecording) {
  getDb().query(`INSERT INTO recording_similarity_nodes
      (canonical_key,artist,title,recording_mbid,updated_at)
      VALUES (?,?,?,?,?)`)
    .run(recording.key, recording.artist, recording.title, recording.mbid, new Date().toISOString());
}

function insertEdge(from: GradientRecording, to: GradientRecording, similarity: number, confidence = 1) {
  getDb().query(`INSERT INTO recording_similarity_edges
      (source_key,target_key,provider,similarity,confidence,directionality,metadata_json,retrieved_at)
      VALUES (?,?,?, ?,?,'observed',NULL,?)`)
    .run(from.key, to.key, "synthetic_cache", similarity, confidence, new Date().toISOString());
}

function maxShare(similarities: Array<{ similarity: number; confidence: number }>) {
  const costs = similarities.map((edge) => gradientRecordingEdgeCost(edge.similarity, edge.confidence));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return Math.max(...costs) / total;
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

    // An exact-length path with extremely cheap comfort-zone edges but one
    // severe cliff. Total-cost-first search is tempted by this shape; minimax
    // must prefer the uniformly moderate route above.
    const cheapCliff = [start, ...clustered, end];
    for (let index = 0; index < cheapCliff.length - 1; index++) {
      insertEdge(cheapCliff[index]!, cheapCliff[index + 1]!, index === 4 ? 0.08 : 0.97);
    }

    // Push one real bridge edge well below a 48-neighbor visibility window.
    // The cached minimax search traverses persisted adjacency directly instead
    // of silently losing bridge evidence to top-N truncation.
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
});
