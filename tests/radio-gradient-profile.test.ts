import { describe, expect, test } from "bun:test";
import { gradientProfileFit, gradientReleaseRecency, normalizeGlobalPopularity } from "../src/services/radio-gradient-profile";

describe("Gradient listening-profile compliance", () => {
  test("distinguishes hidden gems from global hits on an absolute scale", () => {
    expect(normalizeGlobalPopularity(800)!).toBeLessThan(0.1);
    expect(normalizeGlobalPopularity(2_000_000)!).toBeGreaterThan(0.85);
  });

  test("recent release preference is meaningfully recent", () => {
    expect(gradientReleaseRecency(2025, 2026)).toBeGreaterThan(0.85);
    expect(gradientReleaseRecency(2018, 2026)).toBeLessThan(0.4);
    expect(gradientReleaseRecency(1980, 2026)).toBeLessThan(0.01);
  });

  test("hidden-gem plus recent settings prefer the rare recent candidate", () => {
    const settings = { popularityBias: -1, releaseAgeBias: 1 };
    const rareRecent = gradientProfileFit({ popularity: 0.08, releaseYear: 2025, listeners: 900, source: "lastfm" }, settings);
    const famousOld = gradientProfileFit({ popularity: 0.95, releaseYear: 1980, listeners: 2_000_000, source: "lastfm" }, settings);
    expect(rareRecent).toBeGreaterThan(famousOld + 0.75);
  });
});
