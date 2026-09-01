import { describe, expect, test } from "bun:test";
import { DEFAULT_RADIO_SETTINGS } from "../src/db/repositories/radio";
import { radioArtistCooldownKey } from "../src/services/radio-artist-credit";
import {
  artistWithinCooldown,
  selectRadioSequence,
  type RadioSequenceCandidate,
} from "../src/services/radio-sequence";

function candidate(artist: string, title: string, selectionScore: number): RadioSequenceCandidate {
  return {
    key: `text:${artist.toLowerCase()}|${title.toLowerCase()}`,
    artist,
    title,
    album: null,
    selectionScore,
    seedScores: {},
    metadata: {},
  };
}

describe("radio artist cooldown", () => {
  test("featuring credits collapse to the primary artist key", () => {
    expect(radioArtistCooldownKey("Draconian feat. Daniel Änghede")).toBe("draconian");
    expect(radioArtistCooldownKey("Draconian")).toBe("draconian");
  });

  test("hard-skips same artist while alternatives remain", () => {
    const scored = [
      ...Array.from({ length: 8 }, (_, i) => candidate("Draconian", `D${i}`, 10 - i * 0.01)),
      ...Array.from({ length: 12 }, (_, i) => candidate(`Other${i}`, `O${i}`, 3)),
    ];
    const settings = {
      ...DEFAULT_RADIO_SETTINGS,
      artistCooldown: 5,
      repeatStrength: 0.8,
      sameArtistBias: 0.35,
      seedArtistFrequency: 0.16,
      djFlow: 0,
    };
    const sequence = selectRadioSequence(
      scored,
      20,
      settings,
      [{ id: "seed", artist: "Draconian", position: null, weight: 1 }],
      "standard",
      "cooldown-test",
    );

    const artists = sequence.map((track) => radioArtistCooldownKey(track.artist));
    let othersSeen = 0;
    for (let i = 0; i < artists.length; i++) {
      if (artists[i] !== "draconian") {
        othersSeen++;
        continue;
      }
      if (i === 0) continue;
      const previous = artists.lastIndexOf("draconian", i - 1);
      if (previous < 0 || previous >= i) continue;
      const gap = i - previous;
      if (othersSeen < 12) expect(gap).toBeGreaterThan(settings.artistCooldown);
    }
    expect(artists.filter((artist) => artist === "draconian").length).toBe(8);
  });

  test("featuring credits share the same hard cooldown", () => {
    const scored = [
      candidate("Draconian", "A", 10),
      candidate("Draconian feat. Guest", "B", 9.9),
      candidate("Other", "C", 2),
      candidate("Other2", "D", 2),
      candidate("Other3", "E", 2),
      candidate("Other4", "F", 2),
      candidate("Other5", "G", 2),
      candidate("Other6", "H", 2),
    ];
    const settings = { ...DEFAULT_RADIO_SETTINGS, artistCooldown: 5, djFlow: 0, surprise: 0 };
    const sequence = selectRadioSequence(
      scored,
      8,
      settings,
      [{ id: "seed", artist: "Draconian", position: null }],
      "standard",
      "feat-cooldown",
    );
    expect(sequence[0]!.artist).toBe("Draconian");
    expect(radioArtistCooldownKey(sequence[1]!.artist)).not.toBe("draconian");
  });

  test("exhaustion prefers the longest artist gap over raw seed score", () => {
    const scored = [
      candidate("Draconian", "D1", 20),
      candidate("Draconian", "D2", 19),
      candidate("Draconian", "D3", 18),
      candidate("Other", "O1", 3),
      candidate("Other", "O2", 3),
      candidate("Other", "O3", 3),
    ];
    const settings = { ...DEFAULT_RADIO_SETTINGS, artistCooldown: 5, djFlow: 0, surprise: 0 };
    const sequence = selectRadioSequence(
      scored,
      6,
      settings,
      [{ id: "seed", artist: "Draconian", position: null }],
      "standard",
      "exhaust-gap",
    );
    const artists = sequence.map((track) => radioArtistCooldownKey(track.artist));
    // With only two artists, cooldown forces alternation once both are cooling down.
    expect(artists.join(",")).toBe("draconian,other,draconian,other,draconian,other");
  });

  test("exhaustion still fills when only cooldown violators remain", () => {
    const scored = Array.from({ length: 6 }, (_, i) => candidate("Only", `T${i}`, 5 - i));
    const settings = { ...DEFAULT_RADIO_SETTINGS, artistCooldown: 5, djFlow: 0 };
    const sequence = selectRadioSequence(
      scored,
      6,
      settings,
      [{ id: "seed", artist: "Only", position: null }],
      "standard",
      "exhaust",
    );
    expect(sequence).toHaveLength(6);
  });

  test("artistWithinCooldown matches select semantics", () => {
    const artistLast = new Map([["draconian", 0]]);
    expect(artistWithinCooldown("draconian", 5, artistLast, 5)).toBe(true);
    expect(artistWithinCooldown("draconian", 6, artistLast, 5)).toBe(false);
    expect(artistWithinCooldown("draconian", 1, artistLast, 0)).toBe(false);
  });
});
