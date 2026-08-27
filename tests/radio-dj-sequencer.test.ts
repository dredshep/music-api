import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";
import {
  createGeneration,
  createStation,
  getGenerationTracks,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { resequenceRadioGeneration } from "../src/services/radio-dj-sequencer";

const dbPath = `/tmp/music-api-radio-dj-${Date.now()}.sqlite`;

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

afterAll(() => {
  try { unlinkSync(dbPath); } catch {}
});

function makeTrack(key: string, title: string, position: number, options: { pinned?: boolean; manual?: boolean; trajectory?: number | null } = {}) {
  return {
    position,
    canonical_key: key,
    artist: title,
    title,
    album: null,
    duration_ms: 200000,
    isrc: null,
    spotify_id: null,
    navidrome_id: `nd-${title}`,
    musicbrainz_id: null,
    playback_source: "navidrome",
    availability_status: "local",
    pinned: options.pinned ? 1 : 0,
    manual: options.manual ? 1 : 0,
    selection_score: 1,
    trajectory_position: options.trajectory ?? null,
    metadata_json: null,
  };
}

function addTempo(key: string, bpm: number) {
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO track_audio_analysis (
    canonical_key,analysis_version,bpm,status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?)`).run(key, 1, bpm, "ready", now, now);
}

describe("Radio DJ sequencer", () => {
  test("uses cached BPM to improve ordering while keeping the first stable tie", () => {
    const station = createStation({
      name: "DJ",
      seeds: [{ type: "artist", artist: "A", label: "A" }],
      settings: {
        length: 3,
        djFlow: 1,
        djWeights: { tempo: 1, key: 0, energy: 0, timbre: 0, introOutro: 0, semantic: 0, artistSpacing: 0 },
      },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 3,
      generatorVersion: "test",
      randomSeed: "dj",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      makeTrack("text:a|a", "A", 0),
      makeTrack("text:c|c", "C", 1),
      makeTrack("text:b|b", "B", 2),
    ]);
    addTempo("text:a|a", 100);
    addTempo("text:b|b", 102);
    addTempo("text:c|c", 180);

    resequenceRadioGeneration(generation.id);
    expect(getGenerationTracks(generation.id).map((track) => track.title)).toEqual(["A", "B", "C"]);
  });

  test("does not move pinned/manual positions or locked regenerate prefixes", () => {
    const station = createStation({
      name: "DJ constraints",
      seeds: [{ type: "artist", artist: "A", label: "A" }],
      settings: {
        length: 4,
        djFlow: 1,
        djWeights: { tempo: 1, key: 0, energy: 0, timbre: 0, introOutro: 0, semantic: 0, artistSpacing: 0 },
      },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 4,
      generatorVersion: "test",
      randomSeed: "constraints",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      makeTrack("text:a2|a2", "A2", 0),
      makeTrack("text:pinned|pinned", "Pinned", 1, { pinned: true }),
      makeTrack("text:c2|c2", "C2", 2),
      makeTrack("text:b2|b2", "B2", 3),
    ]);
    addTempo("text:a2|a2", 100);
    addTempo("text:pinned|pinned", 101);
    addTempo("text:b2|b2", 102);
    addTempo("text:c2|c2", 180);

    resequenceRadioGeneration(generation.id, { fromPosition: 2 });
    const tracks = getGenerationTracks(generation.id);
    expect(tracks[0]!.title).toBe("A2");
    expect(tracks[1]!.title).toBe("Pinned");
    expect(tracks.slice(2).map((track) => track.title)).toEqual(["B2", "C2"]);
  });

  test("keeps gradient tracks inside a small neighbourhood of their trajectory", () => {
    const station = createStation({
      name: "Gradient DJ",
      type: "gradient",
      seeds: [
        { type: "artist", artist: "A", label: "A", position: 0 },
        { type: "artist", artist: "B", label: "B", position: 1 },
      ],
      settings: {
        length: 6,
        djFlow: 1,
        djWeights: { tempo: 1, key: 0, energy: 0, timbre: 0, introOutro: 0, semantic: 0, artistSpacing: 0 },
      },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 6,
      generatorVersion: "test",
      randomSeed: "gradient",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    const tracks = Array.from({ length: 6 }, (_, index) => makeTrack(
      `text:g${index}|g${index}`,
      `G${index}`,
      index,
      { trajectory: index / 5 },
    ));
    replaceGenerationTracks(generation.id, tracks);
    [100, 200, 102, 198, 104, 196].forEach((bpm, index) => addTempo(`text:g${index}|g${index}`, bpm));

    resequenceRadioGeneration(generation.id);
    const reordered = getGenerationTracks(generation.id);
    for (let index = 0; index < reordered.length; index++) {
      const trajectory = reordered[index]!.trajectory_position!;
      expect(Math.abs(trajectory - index / 5)).toBeLessThanOrEqual(0.4);
    }
  });
});
