import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import {
  addFeedback,
  createGeneration,
  createStation,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { expandPositiveRadioFeedback } from "../src/services/radio-feedback-expansion";
import { canonicalRadioTrackKey } from "../src/services/radio";

const dbPath = `/tmp/music-api-radio-feedback-expansion-${Date.now()}.sqlite`;

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

describe("Radio More Like feedback expansion", () => {
  test("resolves the rated saved track and requests its similar-track neighbourhood", async () => {
    const station = createStation({
      name: "Feedback radio",
      seeds: [{ type: "artist", artist: "Seed", label: "Seed" }],
      settings: { length: 3 },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 3,
      generatorVersion: "test",
      randomSeed: "feedback",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    const key = canonicalRadioTrackKey("Poppy", "Concrete");
    replaceGenerationTracks(generation.id, [{
      canonical_key: key,
      artist: "Poppy",
      title: "Concrete",
      album: null,
      duration_ms: 220000,
      isrc: null,
      spotify_id: null,
      navidrome_id: null,
      musicbrainz_id: null,
      playback_source: null,
      availability_status: "unavailable",
      pinned: 0,
      manual: 0,
      selection_score: 1,
      trajectory_position: null,
      metadata_json: null,
    }]);
    addFeedback({
      scope: "station",
      stationId: station.id,
      entityType: "track",
      entityKey: key,
      action: "more_like",
      strength: 1.5,
    });

    const calls: unknown[][] = [];
    const result = await expandPositiveRadioFeedback(station.id, 8, 24, async (artist, title, limit) => {
      calls.push([artist, title, limit]);
      return [{
        name: "STFU!",
        artist: "Rina Sawayama",
        artistMbid: "",
        mbid: "mbid-1",
        url: "",
        match: 0.77,
        playcount: 0,
        rank: 1,
      }];
    });

    expect(calls).toEqual([["Poppy", "Concrete", 24]]);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([{
      artist: "Rina Sawayama",
      title: "STFU!",
      mbid: "mbid-1",
      score: 0.77,
      strength: 1.5,
      sourceArtist: "Poppy",
      sourceTitle: "Concrete",
    }]);
  });
});
