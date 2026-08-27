import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import { getDb } from "../src/db/database";
import {
  createGeneration,
  createStation,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { buildRadioHistoryPenalties } from "../src/services/radio-repeat-history";

const dbPath = `/tmp/music-api-radio-repeat-history-test-${Date.now()}.sqlite`;
const now = Date.parse("2026-08-27T12:00:00Z");

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

function addGeneration(stationId: string, createdAt: string, key: string, artist: string) {
  const generation = createGeneration({
    stationId,
    requestedLength: 1,
    generatorVersion: "radio-v2",
    randomSeed: key,
    settingsSnapshot: parseRadioSettings(null),
  });
  replaceGenerationTracks(generation.id, [{
    canonical_key: key,
    artist,
    title: key,
    album: null,
    duration_ms: null,
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
  getDb().query("UPDATE radio_generations SET created_at=? WHERE id=?").run(createdAt, generation.id);
}

describe("Radio repeat-history decay", () => {
  test("recent generations apply stronger pressure while old music naturally falls out", () => {
    const station = createStation({
      name: "Decay test",
      seeds: [{ type: "artist", artist: "Seed", label: "Seed" }],
    });

    addGeneration(station.id, "2026-08-27T11:00:00Z", "track:recent", "Recent Artist");
    addGeneration(station.id, "2026-08-20T12:00:00Z", "track:week", "Week Artist");
    addGeneration(station.id, "2026-07-28T12:00:00Z", "track:month", "Month Artist");
    addGeneration(station.id, "2025-08-27T12:00:00Z", "track:year", "Year Artist");

    const penalties = buildRadioHistoryPenalties(station.id, 20, now);
    const recent = penalties.tracks.get("track:recent") ?? 0;
    const week = penalties.tracks.get("track:week") ?? 0;
    const month = penalties.tracks.get("track:month") ?? 0;

    expect(recent).toBeGreaterThan(week);
    expect(week).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(0);
    expect(penalties.tracks.has("track:year")).toBe(false);
    expect(penalties.artists.get("recent artist") ?? 0).toBeGreaterThan(penalties.artists.get("week artist") ?? 0);
  });
});
