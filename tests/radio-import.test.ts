import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import { createGeneration, createStation, parseRadioSettings } from "../src/db/repositories/radio";
import { importExternalGeneration } from "../src/services/radio-import";

const dbPath = `/tmp/music-api-radio-import-test-${Date.now()}.sqlite`;

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

describe("external Radio generation import", () => {
  test("keeps exact playlist length and prefers resolved local playback", async () => {
    const station = createStation({
      name: "Spotify round trip",
      seeds: [{ type: "artist", artist: "A", label: "A" }],
      settings: { length: 2 },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 2,
      generatorVersion: "radio-v2",
      randomSeed: "import",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });

    const imported = await importExternalGeneration(generation.id, [
      { artist: "A", title: "One", spotifyId: "sp1" },
      { artist: "B", title: "Two", spotifyId: "sp2" },
      { artist: "C", title: "Three", spotifyId: "sp3" },
    ], async (tracks) => tracks.map((track, index) => index === 0
      ? { ...track, navidromeId: "nd1", album: "Local Album" }
      : track));

    expect(imported?.requested_length).toBe(3);
    expect(imported?.tracks).toHaveLength(3);
    expect(imported?.tracks.map((track) => track.spotify_id)).toEqual(["sp1", "sp2", "sp3"]);
    expect(imported?.tracks[0]).toMatchObject({
      navidrome_id: "nd1",
      playback_source: "navidrome",
      availability: "local",
    });
    expect(imported?.tracks[1]).toMatchObject({
      navidrome_id: null,
      playback_source: "spotify",
      availability: "spotify",
    });
    expect(imported?.diagnostics).toMatchObject({
      imported_external_playlist: true,
      imported_track_count: 3,
      local_match_count: 1,
    });
  });
});
