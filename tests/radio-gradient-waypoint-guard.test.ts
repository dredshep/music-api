import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import {
  createGeneration,
  createStation,
  finishGeneration,
  getGenerationTracks,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { canonicalRadioTrackKey } from "../src/services/radio";
import { enforceExplicitGradientTrackWaypoints } from "../src/services/radio-gradient-waypoint-guard";

const dbPath = `/tmp/music-api-gradient-waypoint-${Date.now()}.sqlite`;

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

function stored(artist: string, title: string, position: number, route: number) {
  return {
    position,
    canonical_key: canonicalRadioTrackKey(artist, title),
    artist,
    title,
    album: null,
    duration_ms: 200000,
    isrc: null,
    spotify_id: null,
    navidrome_id: null,
    musicbrainz_id: null,
    playback_source: null,
    availability_status: "unknown",
    pinned: 0,
    manual: 0,
    selection_score: 1,
    trajectory_position: route,
    metadata_json: JSON.stringify({ trajectoryCoordinateKind: "musical_route" }),
  };
}

describe("explicit Gradient track waypoint guard", () => {
  test("inserts exact track endpoints and preserves finite length", () => {
    const station = createStation({
      name: "Track path",
      type: "gradient",
      seeds: [
        { type: "track", artist: "Start Artist", title: "Exact Start", label: "Exact Start", position: 0 },
        { type: "track", artist: "End Artist", title: "Exact End", label: "Exact End", position: 1 },
      ],
    });
    const settings = parseRadioSettings(station.settings_json);
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 4,
      generatorVersion: "test",
      randomSeed: "waypoints",
      settingsSnapshot: settings,
    });
    replaceGenerationTracks(generation.id, [
      stored("Bridge One", "One", 0, 0.1),
      stored("Bridge Two", "Two", 1, 0.35),
      stored("Bridge Three", "Three", 2, 0.7),
      stored("Bridge Four", "Four", 3, 0.9),
    ]);
    finishGeneration(generation.id, "ready", { gradient_route: { usable: true } });

    const result = enforceExplicitGradientTrackWaypoints(generation.id);
    expect(result.applied).toBe(true);
    expect(result.inserted).toBe(2);
    const tracks = getGenerationTracks(generation.id);
    expect(tracks).toHaveLength(4);
    expect(tracks[0]!.canonical_key).toBe(canonicalRadioTrackKey("Start Artist", "Exact Start"));
    expect(tracks.at(-1)!.canonical_key).toBe(canonicalRadioTrackKey("End Artist", "Exact End"));
    expect(tracks[0]!.trajectory_position).toBe(0);
    expect(tracks.at(-1)!.trajectory_position).toBe(1);
  });

  test("does not rewrite an explicit waypoint inside a locked regenerate prefix", () => {
    const station = createStation({
      name: "Locked track path",
      type: "gradient",
      seeds: [
        { type: "track", artist: "A", title: "A track", label: "A track", position: 0 },
        { type: "track", artist: "B", title: "B track", label: "B track", position: 1 },
      ],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 3,
      generatorVersion: "test",
      randomSeed: "locked",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      stored("User kept", "Prefix", 0, 0.2),
      stored("Bridge", "Middle", 1, 0.5),
      stored("B", "B track", 2, 1),
    ]);
    finishGeneration(generation.id, "ready", { gradient_route: { usable: true } });
    const result = enforceExplicitGradientTrackWaypoints(generation.id, { fromPosition: 1 });
    expect(result.skippedLocked).toBeGreaterThan(0);
    expect(getGenerationTracks(generation.id)[0]!.title).toBe("Prefix");
  });
});
