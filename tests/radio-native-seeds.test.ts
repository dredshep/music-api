import { describe, expect, test } from "bun:test";
import { hydrateNativeRadioSeeds } from "../src/services/radio-native-seeds";

describe("native Radio seed hydration", () => {
  test("hydrates library from Navidrome and leaves liked seeds client-owned", async () => {
    const seeds = await hydrateNativeRadioSeeds([
      {
        type: "library",
        label: "Library",
        metadata: { tracks: [{ artist: "Wrong", title: "Spotify substitute" }] },
      },
      {
        type: "liked",
        label: "Spotify Likes",
        metadata: { tracks: [{ artist: "Liked Artist", title: "Liked Song", spotifyId: "sp1" }] },
      },
    ], async (size) => {
      expect(size).toBe(200);
      return [{
        id: "nd1",
        artist: "Local Artist",
        title: "Local Song",
        album: "Local Album",
        albumId: "album1",
        artistId: "artist1",
        duration: 123.456,
        year: 2024,
      }];
    });

    expect(seeds[0]?.metadata?.source).toBe("navidrome_library");
    expect(seeds[0]?.metadata?.tracks).toEqual([{
      artist: "Local Artist",
      title: "Local Song",
      album: "Local Album",
      durationMs: 123456,
      releaseYear: 2024,
      navidromeId: "nd1",
      weight: 1,
    }]);
    expect(seeds[1]?.metadata?.tracks).toEqual([{
      artist: "Liked Artist",
      title: "Liked Song",
      spotifyId: "sp1",
    }]);
  });

  test("does not touch providers when no backend-owned seed is present", async () => {
    let called = false;
    const original = [{ type: "artist" as const, label: "Sabaton", artist: "Sabaton" }];
    const result = await hydrateNativeRadioSeeds(original, async () => {
      called = true;
      return [];
    });
    expect(result).toBe(original);
    expect(called).toBe(false);
  });
});
