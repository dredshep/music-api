import { describe, expect, test } from "bun:test";
import { matchLibraryTrack } from "../src/domain/track-ownership";
import type { LibrarySong } from "../src/services/navidrome";

const song = (overrides: Partial<LibrarySong> = {}): LibrarySong => ({
  id: "song-1",
  title: "Teardrop",
  album: "Mezzanine",
  artist: "Massive Attack",
  albumId: "album-1",
  artistId: "artist-1",
  duration: 330,
  ...overrides,
});

describe("matchLibraryTrack", () => {
  test("exact artist, title, and duration is owned", () => {
    const result = matchLibraryTrack(
      { artist: "Massive Attack", title: "Teardrop", album: "Mezzanine", durationMs: 330000 },
      [song()]
    );
    expect(result.status).toBe("owned");
    expect(result.match?.navidromeId).toBe("song-1");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("exact artist and title is owned even without duration", () => {
    const result = matchLibraryTrack(
      { artist: "Massive Attack", title: "Teardrop" },
      [song()]
    );
    expect(result.status).toBe("owned");
  });

  test("same title by a different artist is not owned", () => {
    const result = matchLibraryTrack(
      { artist: "Portishead", title: "Teardrop", durationMs: 330000 },
      [song()]
    );
    expect(result.status).not.toBe("owned");
  });

  test("large duration mismatch prevents an otherwise exact match from being owned", () => {
    const result = matchLibraryTrack(
      { artist: "Massive Attack", title: "Teardrop", durationMs: 240000 },
      [song()]
    );
    expect(result.status).toBe("uncertain");
  });

  test("returns missing when no plausible song exists", () => {
    const result = matchLibraryTrack(
      { artist: "Massive Attack", title: "Teardrop", durationMs: 330000 },
      [song({ title: "Angel", duration: 380 })]
    );
    expect(result.status).toBe("missing");
  });
});
