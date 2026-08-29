import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";
import { canonicalRadioTrackKey } from "../src/services/radio";
import { gradientRecording } from "../src/services/radio-gradient-recording-path";
import { createCachedGradientRecordingProvider } from "../src/services/radio-gradient-recording-provider";
import { createValidatedGradientRecordingProvider } from "../src/services/radio-gradient-recording-validated-provider";

const dbPath = `/tmp/music-api-gradient-edge-lookup-${Date.now()}.sqlite`;

beforeAll(() => {
  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = "test-test-test-test-test-test-test-test";
  process.env.NAVIDROME_USERNAME = "test";
  process.env.NAVIDROME_PASSWORD = "test";
  process.env.LASTFM_API_KEY = "test";
  process.env.LASTFM_USERNAME = "test";
  delete process.env.GRADIENT_SIMIL_ENABLED;
  resetConfigForTests();
  initDatabase();
});

afterAll(() => { try { unlinkSync(dbPath); } catch {} });

beforeEach(() => {
  getDb().exec("DELETE FROM recording_similarity_edges; DELETE FROM recording_similarity_fetches; DELETE FROM recording_similarity_nodes; DELETE FROM track_audio_analysis;");
});

function node(artist: string, title: string) {
  const recording = gradientRecording(artist, title);
  getDb().query(`INSERT INTO recording_similarity_nodes
      (canonical_key,artist,title,recording_mbid,updated_at)
      VALUES (?,?,?,?,?)`)
    .run(recording.key, artist, title, null, new Date().toISOString());
  return recording;
}

function edge(
  from: ReturnType<typeof gradientRecording>,
  to: ReturnType<typeof gradientRecording>,
  similarity: number,
  confidence = 0.82,
) {
  getDb().query(`INSERT INTO recording_similarity_edges
      (source_key,target_key,provider,similarity,confidence,directionality,metadata_json,retrieved_at)
      VALUES (?,?,'lastfm_track',?,?,'observed',NULL,?)`)
    .run(from.key, to.key, similarity, confidence, new Date().toISOString());
}

function markLastFmFresh(sourceKey: string, resultCount: number) {
  getDb().query(`INSERT INTO recording_similarity_fetches
      (source_key,provider,status,result_count,error,retrieved_at)
      VALUES (?,'lastfm_track','ready',?,NULL,?)`)
    .run(sourceKey, resultCount, new Date().toISOString());
}

function analysis(artist: string, title: string, input: {
  bpm: number;
  loudness: number;
  energy: number;
  centroid: number;
  centroidStd: number;
  zcr: number;
  introDbfs: number;
  outroDbfs: number;
}) {
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO track_audio_analysis
      (canonical_key,analysis_version,bpm,musical_key,mode,loudness,energy,timbre_json,rhythm_json,intro_json,outro_json,source_fingerprint,status,error,created_at,updated_at)
      VALUES (?,1,?,'C','major',?,?,?,NULL,?,?,NULL,'ready',NULL,?,?)`)
    .run(
      canonicalRadioTrackKey(artist, title),
      input.bpm,
      input.loudness,
      input.energy,
      JSON.stringify({
        spectral_centroid_mean: input.centroid,
        spectral_centroid_std: input.centroidStd,
        zero_crossing_rate_mean: input.zcr,
      }),
      JSON.stringify({ dbfs: input.introDbfs }),
      JSON.stringify({ dbfs: input.outroDbfs }),
      now,
      now,
    );
}

describe("Gradient direct edge lookup", () => {
  test("finds reverse-only cached evidence for a requested adjacency", () => {
    const source = node("Source", "Start");
    const target = node("Target", "End");
    edge(target, source, 0.61);

    const provider = createCachedGradientRecordingProvider();
    const found = provider.lookupEdge(source.key, target.key);

    expect(found).not.toBeNull();
    expect(found!.key).toBe(target.key);
    expect(found!.similarity).toBeCloseTo(0.61);
  });

  test("point lookup finds a valid edge even when target is outside the top-N neighbor list", async () => {
    const source = node("Source", "Start");
    const target = node("Deep Target", "End");
    edge(target, source, 0.20);

    for (let index = 0; index < 60; index++) {
      const decoy = node(`Decoy ${index}`, `Track ${index}`);
      edge(source, decoy, 0.95 - index * 0.005);
    }
    markLastFmFresh(source.key, 60);

    const provider = createCachedGradientRecordingProvider();
    const top = await provider.bidirectionalNeighbors(source, 48);
    expect(top.some((row) => row.key === target.key)).toBe(false);

    const found = provider.lookupEdge(source.key, target.key);
    expect(found).not.toBeNull();
    expect(found!.key).toBe(target.key);
  });

  test("validated point lookup rejects a catastrophic cached acoustic cliff", () => {
    const source = node("Quiet Source", "Start");
    const target = node("Harsh Target", "End");
    edge(target, source, 0.99, 0.95);

    analysis(source.artist, source.title, {
      bpm: 90,
      loudness: -60,
      energy: 0,
      centroid: 100,
      centroidStd: 0,
      zcr: 0,
      introDbfs: -60,
      outroDbfs: -60,
    });
    analysis(target.artist, target.title, {
      bpm: 140,
      loudness: 0,
      energy: 1,
      centroid: 3600,
      centroidStd: 2200,
      zcr: 0.25,
      introDbfs: 0,
      outroDbfs: 0,
    });

    const provider = createValidatedGradientRecordingProvider();
    expect(provider.lookupEdge?.(source.key, target.key)).toBeNull();
    const diagnostics = provider.diagnostics();
    expect(diagnostics.catastrophicRejectedEdges).toBe(1);
    expect(Object.values(diagnostics.catastrophicReasons).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
  });
});
