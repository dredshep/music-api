import { describe, test, expect } from "bun:test";
import { computeScanProgress } from "../src/services/scan-status";

describe("computeScanProgress", () => {
  test("returns null when not scanning", () => {
    expect(
      computeScanProgress({
        scanning: false,
        filesScanned: 100,
        libraryTotalTracks: 1000,
      })
    ).toEqual({ progress_percent: null, progress_note: null });
  });

  test("computes approximate percent while scanning", () => {
    const result = computeScanProgress({
      scanning: true,
      filesScanned: 250,
      libraryTotalTracks: 1000,
    });
    expect(result.progress_percent).toBe(25);
    expect(result.progress_note).toContain("Approximate");
  });

  test("caps at 99 while scanning", () => {
    const result = computeScanProgress({
      scanning: true,
      filesScanned: 9999,
      libraryTotalTracks: 1000,
    });
    expect(result.progress_percent).toBe(99);
  });

  test("unknown total yields note without percent", () => {
    const result = computeScanProgress({
      scanning: true,
      filesScanned: 10,
      libraryTotalTracks: null,
    });
    expect(result.progress_percent).toBeNull();
    expect(result.progress_note).toContain("unknown");
  });
});
