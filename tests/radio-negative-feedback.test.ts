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
import { canonicalRadioTrackKey } from "../src/services/radio";
import { buildNegativeRadioFeedbackPenalties } from "../src/services/radio-negative-feedback";

const dbPath = `/tmp/music-api-radio-negative-feedback-${Date.now()}.sqlite`;

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

describe("Radio Less Like feedback expansion", () => {
  test("builds a soft penalty map for similar tracks", async () => {
    const station = createStation({
      name: "Negative feedback",
      seeds: [{ type: "artist", artist: "Seed", label: "Seed" }],
      settings: { length: 2 },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 2,
      generatorVersion: "test",
      randomSeed: "negative",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    const sourceKey = canonicalRadioTrackKey("Artist", "Source");
    replaceGenerationTracks(generation.id, [{
      canonical_key: sourceKey,
      artist: "Artist",
      title: "Source",
      album: null,
      duration_ms: 1000,
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
    addFeedback({ scope: "station", stationId: station.id, entityType: "track", entityKey: sourceKey, action: "less_like", strength: 2 });

    const result = await buildNegativeRadioFeedbackPenalties(station.id, 8, 24, async () => [{
      name: "Neighbor",
      artist: "Other",
      artistMbid: "",
      mbid: "",
      url: "",
      match: 0.8,
      playcount: 0,
      rank: 1,
    }]);

    expect(result.errors).toEqual([]);
    expect(result.penalties.get(canonicalRadioTrackKey("Other", "Neighbor"))).toBeCloseTo(0.88, 8);
  });
});
