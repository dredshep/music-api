import { describe, expect, test } from "bun:test";
import { DEFAULT_RADIO_SETTINGS } from "../src/db/repositories/radio";
import { radioSeedProviderBucket } from "../src/services/radio";

describe("Radio provider identity", () => {
  test("keeps local library, Spotify likes, playlists and generic collections separate", () => {
    expect(radioSeedProviderBucket("library")).toBe("navidrome_library");
    expect(radioSeedProviderBucket("liked")).toBe("spotify_taste");
    expect(radioSeedProviderBucket("playlist")).toBe("spotify_playlist");
    expect(radioSeedProviderBucket("collection")).toBe("collection_seed");
  });

  test("all supplied-seed provider buckets have explicit configurable defaults", () => {
    for (const key of ["navidrome_library", "spotify_taste", "spotify_playlist", "collection_seed"]) {
      expect(DEFAULT_RADIO_SETTINGS.providerWeights[key]).toBeNumber();
      expect(DEFAULT_RADIO_SETTINGS.providerWeights[key]).toBeGreaterThan(0);
    }
    expect(DEFAULT_RADIO_SETTINGS.providerWeights.spotify_taste)
      .toBeGreaterThan(DEFAULT_RADIO_SETTINGS.providerWeights.navidrome_library!);
  });
});
