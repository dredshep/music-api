import { describe, test, expect } from "bun:test";
import { scoreCandidate, getCompletenessStatus } from "../src/domain/scoring";
import type { CandidateStats } from "../src/domain/candidates";
import type { CandidateFlagName } from "../src/types/api";

function makeStats(overrides: Partial<CandidateStats> = {}): CandidateStats {
  return {
    audioFileCount: 1,
    trackCount: 1,
    lrcCount: 0,
    matchingLrcCount: 0,
    lrcCoverage: 0,
    imageCount: 0,
    sidecarCount: 0,
    totalBytes: 30_000_000,
    dominantFormat: "FLAC",
    audioFormats: ["FLAC"],
    hasCover: false,
    ...overrides,
  };
}

describe("release-type-aware completeness scoring", () => {
  test("single with 1 track is not penalised", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 1, trackCount: 1 }),
      flags: ["lossless"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      releaseType: "single",
    });
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.reason).not.toContain("incomplete");
  });

  test("single with 2 tracks is not penalised", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 2, trackCount: 2 }),
      flags: ["lossless"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      releaseType: "single",
    });
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.reason).not.toContain("incomplete");
  });

  test("single matching expected track count is complete", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 2, trackCount: 2 }),
      flags: ["lossless"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 2,
      releaseType: "single",
    });
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  test("track release type with 1 audio file is valid", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 1, trackCount: 1, dominantFormat: "MP3", audioFormats: ["MP3"] }),
      flags: ["lossy"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      releaseType: "track",
    });
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.reason).not.toContain("incomplete");
  });

  test("album with 1 track is still penalised without expected count", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 1, trackCount: 1 }),
      flags: ["lossless"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      releaseType: "album",
    });
    expect(result.reason).toContain("incomplete");
  });

  test("album without releaseType: 1 track still penalised (backwards compat)", () => {
    const result = scoreCandidate({
      stats: makeStats({ audioFileCount: 1, trackCount: 1 }),
      flags: ["lossless"] as CandidateFlagName[],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
    });
    expect(result.reason).toContain("incomplete");
  });
});

describe("getCompletenessStatus release-type-aware", () => {
  test("single with 1 track is likely_complete", () => {
    const status = getCompletenessStatus(1, undefined, "single");
    expect(status.status).toBe("likely_complete");
    expect(status.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("single matching expected count is complete", () => {
    const status = getCompletenessStatus(2, 2, "single");
    expect(status.status).toBe("complete");
  });

  test("track with 1 track is likely_complete", () => {
    const status = getCompletenessStatus(1, undefined, "track");
    expect(status.status).toBe("likely_complete");
  });

  test("album with 1 track and no expected is uncertain", () => {
    const status = getCompletenessStatus(1, undefined, "album");
    expect(status.status).toBe("uncertain");
  });

  test("album with 1 track and no expected (no releaseType) is uncertain", () => {
    const status = getCompletenessStatus(1);
    expect(status.status).toBe("uncertain");
  });
});
