import { describe, test, expect } from "bun:test";
import { selectMatchedTrackFiles, type CandidateFile } from "../src/domain/candidates";

describe("selectMatchedTrackFiles", () => {
  const sampleFiles: CandidateFile[] = [
    { filename: "/music/Album/01 - Lovely Head.flac", size: 30000000, kind: "audio", extension: ".flac" },
    { filename: "/music/Album/02 - Paper Bag.flac", size: 28000000, kind: "audio", extension: ".flac" },
    { filename: "/music/Album/03 - Human.flac", size: 32000000, kind: "audio", extension: ".flac" },
    { filename: "/music/Album/01 - Lovely Head.lrc", size: 4000, kind: "lyrics", extension: ".lrc" },
    { filename: "/music/Album/02 - Paper Bag.lrc", size: 3500, kind: "lyrics", extension: ".lrc" },
    { filename: "/music/Album/cover.jpg", size: 500000, kind: "image", extension: ".jpg" },
    { filename: "/music/Album/album.log", size: 2000, kind: "log", extension: ".log" },
  ];

  test("selects matched audio + matching lrc + cover", () => {
    const result = selectMatchedTrackFiles(sampleFiles, "Lovely Head");
    expect(result.length).toBe(3);
    expect(result.some((f) => f.filename.includes("Lovely Head.flac"))).toBe(true);
    expect(result.some((f) => f.filename.includes("Lovely Head.lrc"))).toBe(true);
    expect(result.some((f) => f.kind === "image")).toBe(true);
  });

  test("does not include unrelated audio files", () => {
    const result = selectMatchedTrackFiles(sampleFiles, "Human");
    expect(result.some((f) => f.filename.includes("Human.flac"))).toBe(true);
    expect(result.some((f) => f.filename.includes("Lovely Head.flac"))).toBe(false);
    expect(result.some((f) => f.filename.includes("Paper Bag.flac"))).toBe(false);
  });

  test("does not include unrelated lrc files", () => {
    const result = selectMatchedTrackFiles(sampleFiles, "Human");
    expect(result.some((f) => f.extension === ".lrc")).toBe(false);
  });

  test("handles windows paths", () => {
    const winFiles: CandidateFile[] = [
      { filename: "C:\\Music\\Album\\01 - A New Error.mp3", size: 8000000, kind: "audio", extension: ".mp3" },
      { filename: "C:\\Music\\Album\\01 - A New Error.lrc", size: 2000, kind: "lyrics", extension: ".lrc" },
      { filename: "C:\\Music\\Album\\folder.jpg", size: 200000, kind: "image", extension: ".jpg" },
    ];

    const result = selectMatchedTrackFiles(winFiles, "A New Error");
    expect(result.length).toBe(3);
    expect(result.some((f) => f.filename.includes("A New Error.mp3"))).toBe(true);
    expect(result.some((f) => f.filename.includes("A New Error.lrc"))).toBe(true);
    expect(result.some((f) => f.kind === "image")).toBe(true);
  });

  test("matches with track number prefix", () => {
    const result = selectMatchedTrackFiles(sampleFiles, "02 - Paper Bag");
    expect(result.some((f) => f.filename.includes("Paper Bag.flac"))).toBe(true);
    expect(result.some((f) => f.filename.includes("Paper Bag.lrc"))).toBe(true);
  });

  test("returns best match when no exact match", () => {
    const result = selectMatchedTrackFiles(sampleFiles, "Paper");
    expect(result.some((f) => f.filename.includes("Paper Bag.flac"))).toBe(true);
  });

  test("returns empty for no audio files", () => {
    const noAudio: CandidateFile[] = [
      { filename: "/music/Album/cover.jpg", size: 500000, kind: "image", extension: ".jpg" },
    ];
    const result = selectMatchedTrackFiles(noAudio, "Something");
    expect(result.length).toBe(0);
  });
});
