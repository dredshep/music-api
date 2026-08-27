import { describe, expect, test } from "bun:test";
import { normalizeRadioPopularity } from "../src/services/radio-popularity";

describe("Radio popularity normalization", () => {
  test("log-scales Last.fm playcounts and leaves unknown popularity neutral", () => {
    const rows = normalizeRadioPopularity([
      { metadata: { lastfmPlaycount: 100 } },
      { metadata: { lastfmPlaycount: 10_000 } },
      { metadata: {} },
    ]);

    expect(rows[1]!.metadata.popularity).toBeCloseTo(1, 8);
    expect(rows[0]!.metadata.popularity as number).toBeGreaterThan(0);
    expect(rows[0]!.metadata.popularity as number).toBeLessThan(1);
    expect(rows[2]!.metadata.popularity).toBeUndefined();
  });

  test("preserves explicit normalized popularity instead of replacing it with similarity-like data", () => {
    const rows = normalizeRadioPopularity([
      { metadata: { popularity: 0.8, lastfmPlaycount: 1 } },
      { metadata: { popularity: 2 } },
    ]);
    expect(rows[0]!.metadata.popularity).toBe(0.8);
    expect(rows[1]!.metadata.popularity).toBe(1);
  });
});
