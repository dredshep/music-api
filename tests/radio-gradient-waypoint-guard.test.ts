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

function stored(artist: string, title: string, position: number, route: number, input: { pinned?: boolean; manual?: boolean } = {}) {
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
    pinned: input.pinned ? 1 : 0,
    manual: input.manual ? 1 : 0,
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

  test("persists waypoint metadata when exact tracks are already in their slots", () => {
    const station = createStation({
      name: "Already exact",
      type: "gradient",
      seeds: [
        { type: "track", artist: "A", title: "A track", label: "A track", position: 0 },
        { type: "track", artist: "B", title: "B track", label: "B track", position: 1 },
      ],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 2,
      generatorVersion: "test",
      randomSeed: "already-exact",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      stored("A", "A track", 0, 0),
      stored("B", "B track", 1, 1),
    ]);
    finishGeneration(generation.id, "ready", { gradient_route: { usable: true } });

    const result = enforceExplicitGradientTrackWaypoints(generation.id);
    expect(result.inserted).toBe(0);
    expect(result.moved).toBe(0);
    expect(result.updated).toBe(2);
    const tracks = getGenerationTracks(generation.id);
    for (const track of tracks) {
      const metadata = JSON.parse(track.metadata_json!) as Record<string, unknown>;
      expect(metadata.gradientWaypoint).toBe(true);
      expect(metadata.trajectoryCoordinateKind).toBe("musical_route");
    }
  });

  test("does not rewrite a locked regenerate prefix and resumes the exact route after it", () => {
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
    enforceExplicitGradientTrackWaypoints(generation.id, { fromPosition: 1 });
    const tracks = getGenerationTracks(generation.id);
    expect(tracks[0]!.title).toBe("Prefix");
    expect(tracks[0]!.artist).toBe("User kept");
    expect(tracks.slice(1).map((track) => track.canonical_key)).toContain(canonicalRadioTrackKey("A", "A track"));
  });

  test("never shifts pinned or manual slots while enforcing missing exact waypoints", () => {
    const station = createStation({
      name: "Protected slots",
      type: "gradient",
      seeds: [
        { type: "track", artist: "A", title: "A track", label: "A track", position: 0 },
        { type: "track", artist: "B", title: "B track", label: "B track", position: 1 },
      ],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 5,
      generatorVersion: "test",
      randomSeed: "protected",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      stored("Generated", "Start", 0, 0.1),
      stored("Pinned Artist", "Pinned", 1, 0.3, { pinned: true }),
      stored("Generated", "Middle", 2, 0.5),
      stored("Manual Artist", "Manual", 3, 0.7, { manual: true }),
      stored("Generated", "End", 4, 0.9),
    ]);
    finishGeneration(generation.id, "ready", { gradient_route: { usable: true } });

    const result = enforceExplicitGradientTrackWaypoints(generation.id);
    expect(result.inserted).toBe(2);
    const tracks = getGenerationTracks(generation.id);
    expect(tracks).toHaveLength(5);
    expect(tracks[1]!.title).toBe("Pinned");
    expect(tracks[1]!.pinned).toBe(1);
    expect(tracks[3]!.title).toBe("Manual");
    expect(tracks[3]!.manual).toBe(1);
    expect(tracks[0]!.canonical_key).toBe(canonicalRadioTrackKey("A", "A track"));
    expect(tracks[4]!.canonical_key).toBe(canonicalRadioTrackKey("B", "B track"));
  });

  test("enforces a disconnected track waypoint without fabricating a route coordinate", () => {
    const station = createStation({
      name: "Partial path",
      type: "gradient",
      seeds: [
        { type: "track", artist: "A", title: "A track", label: "A track", position: 0 },
        { type: "track", artist: "B", title: "B track", label: "B track", position: 0.5 },
        { type: "track", artist: "C", title: "C track", label: "C track", position: 1 },
      ],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 5,
      generatorVersion: "test",
      randomSeed: "partial",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      stored("Bridge 1", "One", 0, 0.05),
      stored("Bridge 2", "Two", 1, 0.25),
      stored("Bridge 3", "Three", 2, 0.5),
      stored("Fallback 1", "Four", 3, 0.7),
      stored("Fallback 2", "Five", 4, 0.9),
    ]);
    finishGeneration(generation.id, "partial", {
      gradient_route: {
        usable: true,
        segments: [
          { connected: true, from_position: 0, to_position: 0.5 },
          { connected: false, from_position: 0.5, to_position: 1 },
        ],
      },
    });

    const result = enforceExplicitGradientTrackWaypoints(generation.id);
    expect(result.skippedUnsupported).toBe(0);
    expect(result.unpositioned).toBe(1);
    const tracks = getGenerationTracks(generation.id);
    const keys = tracks.map((track) => track.canonical_key);
    expect(keys).toContain(canonicalRadioTrackKey("A", "A track"));
    expect(keys).toContain(canonicalRadioTrackKey("B", "B track"));
    expect(keys).toContain(canonicalRadioTrackKey("C", "C track"));
    const c = tracks.find((track) => track.canonical_key === canonicalRadioTrackKey("C", "C track"))!;
    expect(c.trajectory_position).toBeNull();
    const metadata = JSON.parse(c.metadata_json!) as Record<string, unknown>;
    expect(metadata.gradientWaypoint).toBe(true);
    expect(metadata.gradientRouteUnsupported).toBe(true);
    expect(metadata.trajectoryCoordinateKind).toBeUndefined();
  });

  test("keeps exact track endpoints on a fully disconnected graph without claiming coordinates", () => {
    const station = createStation({
      name: "No path",
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
      randomSeed: "no-path",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    replaceGenerationTracks(generation.id, [
      stored("Fallback 1", "One", 0, 0),
      stored("Fallback 2", "Two", 1, 0.5),
      stored("Fallback 3", "Three", 2, 1),
    ]);
    finishGeneration(generation.id, "partial", {
      gradient_route: {
        usable: false,
        segments: [{ connected: false, from_position: 0, to_position: 1 }],
      },
    });

    const result = enforceExplicitGradientTrackWaypoints(generation.id);
    expect(result.inserted).toBe(2);
    expect(result.unpositioned).toBe(2);
    const tracks = getGenerationTracks(generation.id);
    expect(tracks[0]!.canonical_key).toBe(canonicalRadioTrackKey("A", "A track"));
    expect(tracks.at(-1)!.canonical_key).toBe(canonicalRadioTrackKey("B", "B track"));
    for (const track of [tracks[0]!, tracks.at(-1)!]) {
      expect(track.trajectory_position).toBeNull();
      const metadata = JSON.parse(track.metadata_json!) as Record<string, unknown>;
      expect(metadata.gradientRouteUnsupported).toBe(true);
      expect(metadata.trajectoryCoordinateKind).toBeUndefined();
    }
  });
});