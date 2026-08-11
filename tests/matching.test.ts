import { describe, test, expect } from "bun:test";
import { matchLibraryAlbums, classifyConfidence } from "../src/domain/matching";
import type { LibraryAlbum } from "../src/services/navidrome";

const mockAlbums: LibraryAlbum[] = [
  {
    id: "nav-1",
    artist: "Massive Attack",
    artistId: "a1",
    title: "Mezzanine",
    year: 1998,
    songCount: 11,
    duration: 3600,
  },
  {
    id: "nav-2",
    artist: "Massive Attack",
    artistId: "a1",
    title: "Protection",
    year: 1994,
    songCount: 10,
    duration: 3000,
  },
  {
    id: "nav-3",
    artist: "Massive Attack",
    artistId: "a1",
    title: "Mezzanine (Deluxe Edition)",
    year: 1998,
    songCount: 15,
    duration: 4200,
  },
  {
    id: "nav-4",
    artist: "Portishead",
    artistId: "a2",
    title: "Dummy",
    year: 1994,
    songCount: 11,
    duration: 2800,
  },
];

describe("matchLibraryAlbums", () => {
  test("exact artist + title match is owned", () => {
    const result = matchLibraryAlbums("Massive Attack", "Mezzanine", mockAlbums);
    expect(result.owned).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.matches[0]?.navidromeId).toBe("nav-1");
  });

  test("deluxe edition satisfies base title", () => {
    const result = matchLibraryAlbums("Massive Attack", "Mezzanine", [mockAlbums[2]!]);
    expect(result.owned).toBe(true);
    expect(result.matches[0]?.matchReasons).toContain("title_edition_variant");
  });

  test("different artist does not match", () => {
    const result = matchLibraryAlbums("Radiohead", "Mezzanine", mockAlbums);
    expect(result.owned).toBe(false);
  });

  test("different title does not match", () => {
    const result = matchLibraryAlbums("Massive Attack", "Blue Lines", mockAlbums);
    expect(result.owned).toBe(false);
  });

  test("year match improves confidence", () => {
    const result = matchLibraryAlbums(
      "Massive Attack",
      "Mezzanine",
      mockAlbums,
      { year: 1998 }
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("classifyConfidence", () => {
  test("high confidence is owned", () => {
    expect(classifyConfidence(0.95)).toBe("owned");
    expect(classifyConfidence(0.90)).toBe("owned");
  });

  test("medium confidence is uncertain", () => {
    expect(classifyConfidence(0.75)).toBe("uncertain");
    expect(classifyConfidence(0.65)).toBe("uncertain");
  });

  test("low confidence is missing", () => {
    expect(classifyConfidence(0.5)).toBe("missing");
    expect(classifyConfidence(0.0)).toBe("missing");
  });
});
