import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";
import { canonicalRadioTrackKey } from "../src/services/radio";
import { discoverValidatedCachedRecordingPath } from "../src/services/radio-gradient-cached-path";
import { gradientRecording } from "../src/services/radio-gradient-recording-path";

const dbPath = `/tmp/music-api-gradient-cached-path-${Date.now()}.sqlite`;

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
  const db = getDb();
  db.exec("DELETE FROM recording_similarity_edges; DELETE FROM recording_similarity_fetches; DELETE FROM recording_similarity_nodes; DELETE FROM track_audio_analysis;");
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
  provider: string,
  similarity: number,
  confidence: number,
) {
  getDb().query(`INSERT INTO recording_similarity_edges
      (source_key,target_key,provider,similarity,confidence,directionality,metadata_json,retrieved_at)
      VALUES (?,?,?,?,?,'observed',NULL,?)`)
    .run(from.key, to.key, provider, similarity, confidence, new Date().toISOString());
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

describe("validated cached Gradient path", () => {
  test("does not synthesize MAX(similarity) and MAX(confidence) from different providers", () => {
    const a = node("A", "a");
    const b = node("B", "b");
    const c = node("C", "c");

    edge(a, b, "high_similarity_low_confidence", 0.95, 0.2);
    edge(a, b, "low_similarity_high_confidence", 0.3, 0.95);
    edge(a, c, "bridge", 0.8, 0.9);
    edge(c, b, "bridge", 0.8, 0.9);

    const path = discoverValidatedCachedRecordingPath([a], [b]);
    expect(path).not.toBeNull();
    expect(path!.recordings.map((row) => row.artist)).toEqual(["A", "C", "B"]);
    expect(path!.edges.map((row) => row.provider)).toEqual(["bridge", "bridge"]);
  });

  test("uses weighted Dijkstra rather than first-intersection FIFO traversal", () => {
    const a = node("A", "a");
    const b = node("B", "b");
    const expensive = node("Expensive", "x");
    const y = node("Y", "y");
    const z = node("Z", "z");

    edge(a, expensive, "cached", 0.22, 0.9);
    edge(expensive, b, "cached", 0.99, 0.9);
    edge(a, y, "cached", 0.82, 0.9);
    edge(y, z, "cached", 0.82, 0.9);
    edge(z, b, "cached", 0.82, 0.9);

    const path = discoverValidatedCachedRecordingPath([a], [b]);
    expect(path).not.toBeNull();
    expect(path!.recordings.map((row) => row.artist)).toEqual(["A", "Y", "Z", "B"]);
  });

  test("rejects a cached edge when cached DSP identifies a catastrophic cliff", () => {
    const a = node("A", "a");
    const b = node("B", "b");
    const c = node("C", "c");

    edge(a, b, "tempting", 0.99, 0.95);
    edge(a, c, "safe_unknown", 0.72, 0.9);
    edge(c, b, "safe_unknown", 0.72, 0.9);

    analysis("A", "a", {
      bpm: 90,
      loudness: -60,
      energy: 0,
      centroid: 100,
      centroidStd: 0,
      zcr: 0,
      introDbfs: -60,
      outroDbfs: -60,
    });
    analysis("B", "b", {
      bpm: 140,
      loudness: 0,
      energy: 1,
      centroid: 3600,
      centroidStd: 2200,
      zcr: 0.25,
      introDbfs: 0,
      outroDbfs: 0,
    });

    const path = discoverValidatedCachedRecordingPath([a], [b]);
    expect(path).not.toBeNull();
    expect(path!.recordings.map((row) => row.artist)).toEqual(["A", "C", "B"]);
    expect(path!.edges.some((row) => row.provider === "tempting")).toBe(false);
  });

  test("excludes a noncompliant bridge while preserving hard endpoints", () => {
    const a = node("A", "a");
    const b = node("B", "b");
    const hit = node("Global Hit", "hit");
    const rare = node("Rare", "rare");
    edge(a, hit, "cached", 0.95, 0.9);
    edge(hit, b, "cached", 0.95, 0.9);
    edge(a, rare, "cached", 0.7, 0.9);
    edge(rare, b, "cached", 0.7, 0.9);

    const path = discoverValidatedCachedRecordingPath([a], [b], { excludedKeys: new Set([hit.key, a.key]) });
    expect(path?.recordings.map((row) => row.artist)).toEqual(["A", "Rare", "B"]);
  });
});
