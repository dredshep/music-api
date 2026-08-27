import { describe, expect, test } from "bun:test";
import {
  MAX_MUSICBRAINZ_RADIO_QUERIES,
  musicBrainzQueryForRadioSeed,
  planMusicBrainzRadioQueries,
} from "../src/services/radio-musicbrainz";

const base = { id: "seed", weight: 1 };

describe("MusicBrainz Radio seed queries", () => {
  test("builds recording and artist searches from semantic seeds", () => {
    expect(musicBrainzQueryForRadioSeed({ ...base, seed_type: "track", artist: "Poppy", title: "Concrete", label: "Concrete" }))
      .toBe('recording:"Concrete" AND artist:"Poppy"');
    expect(musicBrainzQueryForRadioSeed({ ...base, seed_type: "artist", artist: "Sabaton", title: null, label: "Sabaton" }))
      .toBe('artist:"Sabaton"');
    expect(musicBrainzQueryForRadioSeed({ ...base, seed_type: "genre", artist: null, title: null, label: "black metal" }))
      .toBe('tag:"black metal"');
  });

  test("does not pretend client-owned collection seeds are MusicBrainz semantics", () => {
    expect(musicBrainzQueryForRadioSeed({ ...base, seed_type: "playlist", artist: null, title: null, label: "Mix" })).toBeNull();
  });

  test("deduplicates and caps queries while prioritizing seed weight", () => {
    const plan = planMusicBrainzRadioQueries([
      { ...base, id: "low", weight: 0.2, seed_type: "artist", artist: "Low", title: null, label: "Low" },
      { ...base, id: "duplicate-low", weight: 0.3, seed_type: "artist", artist: "Top", title: null, label: "Top duplicate" },
      { ...base, id: "top", weight: 4, seed_type: "artist", artist: "Top", title: null, label: "Top" },
      { ...base, id: "two", weight: 3, seed_type: "genre", artist: null, title: null, label: "power metal" },
      { ...base, id: "three", weight: 2, seed_type: "artist", artist: "Third", title: null, label: "Third" },
      { ...base, id: "four", weight: 1, seed_type: "artist", artist: "Fourth", title: null, label: "Fourth" },
    ]);

    expect(plan).toHaveLength(MAX_MUSICBRAINZ_RADIO_QUERIES);
    expect(plan.map((row) => row.seed.id)).toEqual(["top", "two", "three"]);
    expect(new Set(plan.map((row) => row.query)).size).toBe(plan.length);
  });
});
