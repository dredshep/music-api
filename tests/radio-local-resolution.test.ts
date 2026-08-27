import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import {
  createGeneration,
  createStation,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { resolveRadioGenerationLocally } from "../src/services/radio-local-resolution";

const dbPath = `/tmp/music-api-radio-local-resolution-${Date.now()}.sqlite`;

beforeAll(() => {
  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = "test-test-test-test-test-test-test-test";
  process.env.NAVIDROME_USERNAME = "test";
  process.env.NAVIDROME_PASSWORD = "test";
  process.env.LASTFM_API_KEY = "test";
  process.env.LASTFM_USERNAME = "test";
  process.env.MAX_CONCURRENT_NAVIDROME_REQUESTS = "4";
  resetConfigForTests();
  initDatabase();
});

afterAll(() => {
  try { unlinkSync(dbPath); } catch {}
});

describe("final Radio local resolution", () => {
  test("checks selected tracks after ranking and upgrades an unknown track to local", async () => {
    const station = createStation({
      name: "Local resolver",
      seeds: [{ type: "artist", artist: "Local Artist", label: "Local Artist" }],
      settings: { length: 1 },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 1,
      generatorVersion: "test",
      randomSeed: "resolver",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [{
      canonical_key: "text:local artist|local song",
      artist: "Local Artist",
      title: "Local Song",
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: "spotify-fallback",
      navidrome_id: null,
      musicbrainz_id: null,
      playback_source: "spotify",
      availability_status: "spotify",
      pinned: 0,
      manual: 0,
      selection_score: 1,
      trajectory_position: null,
      metadata_json: null,
    }]);

    const seen: string[] = [];
    const resolved = await resolveRadioGenerationLocally(generation.id, async (query, options) => {
      seen.push(query);
      expect(options?.songCount).toBe(8);
      return {
        artists: [],
        albums: [],
        songs: [{
          id: "nav-local-1",
          title: "Local Song",
          artist: "Local Artist",
          album: "Local Album",
          albumId: "album-1",
          artistId: "artist-1",
          duration: 245.25,
        }],
      };
    });

    expect(seen).toEqual(["Local Artist Local Song"]);
    expect(resolved?.tracks[0]).toMatchObject({
      navidrome_id: "nav-local-1",
      spotify_id: "spotify-fallback",
      playback_source: "navidrome",
      availability: "local",
      album: "Local Album",
      duration_ms: 245250,
    });
  });

  test("keeps the saved generation usable when Navidrome lookup fails", async () => {
    const station = createStation({
      name: "Failure tolerant",
      seeds: [{ type: "artist", artist: "Remote", label: "Remote" }],
      settings: { length: 1 },
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 1,
      generatorVersion: "test",
      randomSeed: "failure",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [{
      canonical_key: "text:remote|song",
      artist: "Remote",
      title: "Song",
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: "sp-remote",
      navidrome_id: null,
      musicbrainz_id: null,
      playback_source: "spotify",
      availability_status: "spotify",
      pinned: 0,
      manual: 0,
      selection_score: 1,
      trajectory_position: null,
      metadata_json: null,
    }]);

    const resolved = await resolveRadioGenerationLocally(generation.id, async () => {
      throw new Error("simulated Navidrome outage");
    });

    expect(resolved?.tracks[0]).toMatchObject({
      spotify_id: "sp-remote",
      navidrome_id: null,
      playback_source: "spotify",
      availability: "spotify",
    });
  });
});
