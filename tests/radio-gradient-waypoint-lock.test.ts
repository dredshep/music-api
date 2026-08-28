import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import {
  createGeneration,
  createStation,
  getGenerationTracks,
  parseRadioSettings,
  replaceGenerationTracks,
} from "../src/db/repositories/radio";
import { canonicalRadioTrackKey } from "../src/services/radio";
import { resequenceRadioGeneration } from "../src/services/radio-dj-sequencer";
import { enforceGradientRouteOrder } from "../src/services/radio-gradient-order-guard";

const dbPath = `/tmp/music-api-gradient-waypoint-lock-${Date.now()}.sqlite`;

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

function stored(
  artist: string,
  title: string,
  position: number,
  route: number | null,
  waypoint = false,
) {
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
    metadata_json: JSON.stringify({
      ...(route == null ? {} : { trajectoryCoordinateKind: "musical_route" }),
      ...(waypoint ? { gradientWaypoint: true } : {}),
    }),
  };
}

function generation(name: string, tracks: ReturnType<typeof stored>[]) {
  const station = createStation({
    name,
    type: "gradient",
    seeds: [
      { type: "artist", artist: "A", label: "A", position: 0 },
      { type: "artist", artist: "B", label: "B", position: 1 },
    ],
  });
  const created = createGeneration({
    stationId: station.id,
    requestedLength: tracks.length,
    generatorVersion: "test",
    randomSeed: name,
    settingsSnapshot: parseRadioSettings(station.settings_json),
  });
  replaceGenerationTracks(created.id, tracks);
  return created.id;
}

describe("Gradient exact waypoint lifecycle locks", () => {
  test("DJ resequencing cannot move an unpositioned exact waypoint", () => {
    const id = generation("DJ lock", [
      stored("Late", "Late", 0, 0.9),
      stored("Exact", "Requested", 1, null, true),
      stored("Early", "Early", 2, 0.1),
      stored("Middle", "Middle", 3, 0.5),
    ]);

    const waypointKey = canonicalRadioTrackKey("Exact", "Requested");
    expect(getGenerationTracks(id).find((track) => track.canonical_key === waypointKey)!.position).toBe(1);
    resequenceRadioGeneration(id);
    expect(getGenerationTracks(id).find((track) => track.canonical_key === waypointKey)!.position).toBe(1);
  });

  test("final route repair cannot move an exact waypoint", () => {
    const id = generation("Order guard lock", [
      stored("Late", "Late", 0, 0.8),
      stored("Exact", "Requested", 1, 0.2, true),
      stored("Middle", "Middle", 2, 0.5),
    ]);

    const waypointKey = canonicalRadioTrackKey("Exact", "Requested");
    const result = enforceGradientRouteOrder(id);
    expect(result?.applied).toBe(true);
    expect(getGenerationTracks(id).find((track) => track.canonical_key === waypointKey)!.position).toBe(1);
  });
});