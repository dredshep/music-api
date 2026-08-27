import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import {
  createGeneration,
  createStation,
  getGenerationTracks,
  getSeeds,
  getStation,
  listGenerations,
  parseRadioSettings,
  replaceGenerationTracks,
  snapshotGeneration,
  updateTrackPin,
} from "../src/db/repositories/radio";
import {
  canonicalRadioTrackKey,
  cloneGeneration,
  insertManualGenerationTrack,
  listGenerationRevisions,
  reorderGenerationTracks,
  revertGenerationRevision,
} from "../src/services/radio";

const dbPath = `/tmp/music-api-radio-test-${Date.now()}.sqlite`;

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

describe("radio persistence", () => {
  test("uses stable cross-provider text identity", () => {
    expect(canonicalRadioTrackKey("Beyoncé", "  Halo! ")).toBe(canonicalRadioTrackKey("beyonce", "Halo"));
    expect(canonicalRadioTrackKey("AC/DC", "Back in Black")).toBe(canonicalRadioTrackKey("AC DC", "Back-in-Black"));
    expect(canonicalRadioTrackKey("Artist A", "Same title")).not.toBe(canonicalRadioTrackKey("Artist B", "Same title"));
  });

  test("keeps station recipe separate from dated generations", () => {
    const station = createStation({
      name: "Pop to black metal",
      type: "gradient",
      settings: { length: 10, familiarity: 0.4 },
      seeds: [
        { type: "artist", artist: "Carly Rae Jepsen", label: "Carly Rae Jepsen", weight: 1, position: 0 },
        { type: "artist", artist: "Taake", label: "Taake", weight: 1, position: 1 },
      ],
    });

    expect(getStation(station.id)?.name).toBe("Pop to black metal");
    expect(getSeeds(station.id).map((s) => s.label)).toEqual(["Carly Rae Jepsen", "Taake"]);
    expect(parseRadioSettings(station.settings_json).length).toBe(10);

    const first = createGeneration({
      stationId: station.id,
      requestedLength: 10,
      generatorVersion: "radio-v1",
      randomSeed: "one",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    const second = createGeneration({
      stationId: station.id,
      requestedLength: 10,
      generatorVersion: "radio-v1",
      randomSeed: "two",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });

    expect(first.id).not.toBe(second.id);
    expect(listGenerations(station.id).length).toBe(2);
    expect(new Set(listGenerations(station.id).map((g) => g.revision))).toEqual(new Set([1, 2]));
  });

  test("stores finite ordered tracks and pin state", () => {
    const station = createStation({
      name: "Sabaton Radio",
      seeds: [{ type: "artist", artist: "Sabaton", label: "Sabaton", weight: 1 }],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 2,
      generatorVersion: "radio-v1",
      randomSeed: "finite",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });

    const tracks = replaceGenerationTracks(generation.id, [
      {
        canonical_key: "text:sabaton|ghost division",
        artist: "Sabaton",
        title: "Ghost Division",
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
      },
      {
        canonical_key: "text:powerwolf|army of the night",
        artist: "Powerwolf",
        title: "Army of the Night",
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
        selection_score: 0.9,
        trajectory_position: null,
        metadata_json: null,
      },
    ]);

    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.position)).toEqual([0, 1]);
    snapshotGeneration(generation.id, "before pin");
    expect(updateTrackPin(generation.id, tracks[1]!.id, true)).toBe(true);
    expect(Boolean(getGenerationTracks(generation.id)[1]?.pinned)).toBe(true);
  });

  test("snapshots edits, reorders, clones, and can restore a prior generation revision", () => {
    const station = createStation({
      name: "Editable Radio",
      seeds: [{ type: "artist", artist: "A", label: "A", weight: 1 }],
    });
    const generation = createGeneration({
      stationId: station.id,
      requestedLength: 3,
      generatorVersion: "radio-v2",
      randomSeed: "editable",
      settingsSnapshot: parseRadioSettings(station.settings_json),
    });
    const original = replaceGenerationTracks(generation.id, ["One", "Two", "Three"].map((title) => ({
      canonical_key: canonicalRadioTrackKey("A", title),
      artist: "A",
      title,
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: null,
      navidrome_id: null,
      musicbrainz_id: null,
      playback_source: null,
      availability_status: "unavailable" as const,
      pinned: 0,
      manual: 0,
      selection_score: 1,
      trajectory_position: null,
      metadata_json: null,
    })));

    const reordered = reorderGenerationTracks(generation.id, [original[2]!.id, original[0]!.id, original[1]!.id]);
    expect(reordered?.tracks.map((track) => track.title)).toEqual(["Three", "One", "Two"]);
    const reorderRevision = listGenerationRevisions(generation.id).find((revision) => revision.reason === "reorder");
    expect(reorderRevision).toBeTruthy();

    const inserted = insertManualGenerationTrack(generation.id, { position: 1, artist: "B", title: "Inserted" });
    expect(inserted?.tracks[1]?.title).toBe("Inserted");
    expect(inserted?.tracks[1]?.manual).toBe(true);

    const restored = revertGenerationRevision(generation.id, reorderRevision!.id);
    expect(restored?.tracks.map((track) => track.title)).toEqual(["One", "Two", "Three"]);

    const clone = cloneGeneration(generation.id);
    expect(clone?.id).not.toBe(generation.id);
    expect(clone?.tracks.map((track) => track.title)).toEqual(["One", "Two", "Three"]);
  });
});
