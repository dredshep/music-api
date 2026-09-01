import { describe, expect, test } from "bun:test";
import { NavidromeMatchIndex } from "../src/services/library-snapshot";
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

describe("NavidromeMatchIndex", () => {
  test("matches an exact input from the whole-library index", () => {
    const index = new NavidromeMatchIndex("snapshot-1", [song()]);
    const result = index.lookup({
      artist: "Massive Attack",
      title: "Teardrop",
      album: "Mezzanine",
      durationMs: 330000,
    });

    expect(result.status).toBe("matched");
    expect(result.match?.navidromeId).toBe("song-1");
    expect(result.match?.artistId).toBe("artist-1");
    expect(result.match?.albumId).toBe("album-1");
  });

  test("uses edition/base-title candidates without another Navidrome search", () => {
    const index = new NavidromeMatchIndex("snapshot-1", [
      song({ id: "song-remaster", title: "Teardrop (Remastered)" }),
    ]);
    const result = index.lookup({ artist: "Massive Attack", title: "Teardrop" });

    expect(result.status).toBe("possible_match");
    expect(result.match?.navidromeId).toBe("song-remaster");
  });

  test("does not make a title-only candidate matched for another artist", () => {
    const index = new NavidromeMatchIndex("snapshot-1", [song()]);
    const result = index.lookup({ artist: "Portishead", title: "Teardrop" });

    expect(result.status).not.toBe("matched");
  });
});
