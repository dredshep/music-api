import { describe, expect, test } from "bun:test";
import { musicBrainzQueryForRadioSeed } from "../src/services/radio-musicbrainz";

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
});
