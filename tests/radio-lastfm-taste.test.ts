import { describe, expect, test } from "bun:test";
import { buildLastFmTasteMap } from "../src/services/radio-lastfm-taste";
import type { LastFmPeriod, LastFmTrack } from "../src/services/lastfm";

function track(name: string, match: number): LastFmTrack {
  return {
    name,
    artist: "Artist",
    artistMbid: "",
    mbid: "",
    url: "",
    match,
    playcount: 1,
    rank: 1,
  };
}

describe("Last.fm Radio taste decay", () => {
  test("weights recent windows more strongly while retaining overall history", async () => {
    const fetcher = async (period: LastFmPeriod) => {
      if (period === "1month") return [track("Current", 1)];
      if (period === "12month") return [track("Yearly", 1)];
      if (period === "overall") return [track("Current", 0.7), track("Old Favorite", 1)];
      return [];
    };

    const map = await buildLastFmTasteMap(fetcher);
    expect(map.get("text:artist|current")).toEqual({ recent: 1, historical: 0.7 });
    expect(map.get("text:artist|yearly")?.recent).toBeCloseTo(0.62, 8);
    expect(map.get("text:artist|old favorite")).toEqual({ recent: 0, historical: 1 });
    expect(map.get("text:artist|current")!.recent).toBeGreaterThan(map.get("text:artist|yearly")!.recent);
  });

  test("uses the strongest nested recent-window evidence instead of double counting", async () => {
    const fetcher = async (period: LastFmPeriod) => {
      if (period === "1month") return [track("Repeat", 0.6)];
      if (period === "3month") return [track("Repeat", 1)];
      return [];
    };
    const map = await buildLastFmTasteMap(fetcher);
    expect(map.get("text:artist|repeat")?.recent).toBeCloseTo(0.9, 8);
  });
});
