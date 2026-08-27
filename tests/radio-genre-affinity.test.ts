import { describe, expect, test } from "bun:test";
import { radioGenreAffinity } from "../src/services/radio-genre-affinity";

describe("Radio genre affinity", () => {
  const seeds = [
    { id: "artist-seed", seed_type: "artist" },
    { id: "genre-seed", seed_type: "genre" },
  ];

  test("ignores generic artist/track seed affinity", () => {
    expect(radioGenreAffinity({ "artist-seed": 1 }, seeds)).toBe(0);
  });

  test("uses only genre/tag seed affinity and clamps it", () => {
    expect(radioGenreAffinity({ "artist-seed": 1, "genre-seed": 0.7 }, seeds)).toBe(0.7);
    expect(radioGenreAffinity({ "genre-seed": 3 }, seeds)).toBe(1);
  });
});
