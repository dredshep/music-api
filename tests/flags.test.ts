import { describe, test, expect } from "bun:test";
import { detectFlags } from "../src/domain/flags";

describe("detectFlags", () => {
  test("detects lossless FLAC", () => {
    const flags = detectFlags({
      directoryName: "Massive Attack - Mezzanine (1998) [FLAC]",
      filenames: ["01.flac", "02.flac"],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("lossless");
    expect(flags).not.toContain("lossy");
  });

  test("detects lossy MP3", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: ["01.mp3", "02.mp3"],
      audioFormats: ["MP3"],
      audioFileCount: 10,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("lossy");
    expect(flags).not.toContain("lossless");
  });

  test("detects mixed formats", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: ["01.flac", "02.mp3"],
      audioFormats: ["FLAC", "MP3"],
      audioFileCount: 10,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("mixed_formats");
  });

  test("detects complete LRC", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 11,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("complete_lrc");
  });

  test("detects live via word boundary, not substring", () => {
    // "Live at Brixton" should trigger live
    const liveFlags = detectFlags({
      directoryName: "Artist - Live at Brixton Academy",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });
    expect(liveFlags).toContain("live");

    // "Alive" should NOT trigger live
    const aliveFlags = detectFlags({
      directoryName: "Daft Punk - Alive 2007",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });
    expect(aliveFlags).not.toContain("live");
  });

  test("detects no_free_slot", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: false,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("no_free_slot");
  });

  test("detects slow_peer", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 50000, // 50 KB/s
      queueLength: 0,
    });

    expect(flags).toContain("slow_peer");
  });

  test("detects deluxe", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album (Deluxe Edition)",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 15,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 0,
    });

    expect(flags).toContain("deluxe");
  });

  test("detects long queue", () => {
    const flags = detectFlags({
      directoryName: "Artist - Album",
      filenames: [],
      audioFormats: ["FLAC"],
      audioFileCount: 11,
      lrcCount: 0,
      freeUploadSlots: true,
      uploadSpeed: 5000000,
      queueLength: 100,
    });

    expect(flags).toContain("long_queue");
  });
});
