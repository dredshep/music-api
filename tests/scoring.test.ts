import { describe, test, expect } from "bun:test";
import { scoreCandidate } from "../src/domain/scoring";
import type { CandidateStats } from "../src/domain/candidates";
import type { CandidateFlagName } from "../src/types/api";

function makeStats(overrides: Partial<CandidateStats> = {}): CandidateStats {
  return {
    audioFileCount: 11,
    trackCount: 11,
    lrcCount: 0,
    matchingLrcCount: 0,
    lrcCoverage: 0,
    imageCount: 1,
    sidecarCount: 0,
    totalBytes: 500_000_000,
    dominantFormat: "FLAC",
    audioFormats: ["FLAC"],
    hasCover: true,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  test("complete FLAC + full LRC scores highest", () => {
    const result = scoreCandidate({
      stats: makeStats({
        dominantFormat: "FLAC",
        matchingLrcCount: 11,
        lrcCoverage: 1.0,
      }),
      flags: ["lossless", "complete_lrc"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
      preferLrc: true,
    });

    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  test("complete FLAC without LRC scores lower than with LRC", () => {
    const withLrc = scoreCandidate({
      stats: makeStats({ matchingLrcCount: 11, lrcCoverage: 1.0 }),
      flags: ["lossless", "complete_lrc"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
      preferLrc: true,
    });

    const withoutLrc = scoreCandidate({
      stats: makeStats({ matchingLrcCount: 0, lrcCoverage: 0 }),
      flags: ["lossless"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
      preferLrc: true,
    });

    expect(withLrc.score).toBeGreaterThan(withoutLrc.score);
  });

  test("complete FLAC without LRC scores higher than complete MP3", () => {
    const flac = scoreCandidate({
      stats: makeStats({ dominantFormat: "FLAC" }),
      flags: ["lossless"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    const mp3 = scoreCandidate({
      stats: makeStats({ dominantFormat: "MP3", audioFormats: ["MP3"] }),
      flags: ["lossy"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    expect(flac.score).toBeGreaterThan(mp3.score);
  });

  test("complete MP3 beats incomplete FLAC", () => {
    const completeMp3 = scoreCandidate({
      stats: makeStats({
        dominantFormat: "MP3",
        audioFormats: ["MP3"],
        audioFileCount: 11,
        trackCount: 11,
      }),
      flags: ["lossy"],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    const incompleteFlac = scoreCandidate({
      stats: makeStats({
        dominantFormat: "FLAC",
        audioFileCount: 4,
        trackCount: 4,
      }),
      flags: ["lossless", "likely_incomplete"],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    expect(completeMp3.score).toBeGreaterThan(incompleteFlac.score);
  });

  test("complete MP3 beats live FLAC", () => {
    const completeMp3 = scoreCandidate({
      stats: makeStats({
        dominantFormat: "MP3",
        audioFormats: ["MP3"],
        audioFileCount: 11,
        trackCount: 11,
      }),
      flags: ["lossy"],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    const liveFlac = scoreCandidate({
      stats: makeStats({
        dominantFormat: "FLAC",
        audioFileCount: 11,
        trackCount: 11,
      }),
      flags: ["lossless", "live"],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    expect(completeMp3.score).toBeGreaterThan(liveFlac.score);
  });

  test("karaoke severely penalized", () => {
    const karaoke = scoreCandidate({
      stats: makeStats({ dominantFormat: "FLAC" }),
      flags: ["lossless", "karaoke"],
      freeUploadSlots: true,
      uploadSpeed: 10_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    expect(karaoke.score).toBeLessThan(40);
  });

  test("no free slot reduces score", () => {
    const withSlot = scoreCandidate({
      stats: makeStats(),
      flags: ["lossless"],
      freeUploadSlots: true,
      uploadSpeed: 5_000_000,
      queueLength: 0,
      expectedTrackCount: 11,
    });

    const withoutSlot = scoreCandidate({
      stats: makeStats(),
      flags: ["lossless", "no_free_slot"],
      freeUploadSlots: false,
      uploadSpeed: 5_000_000,
      queueLength: 100,
      expectedTrackCount: 11,
    });

    expect(withSlot.score).toBeGreaterThan(withoutSlot.score);
  });
});
