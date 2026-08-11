import { describe, test, expect } from "bun:test";
import {
  classifyFile,
  getExtension,
  getParentDirectory,
  getFilename,
  groupByDirectory,
  computeStats,
  selectDownloadFiles,
  type CandidateFile,
} from "../src/domain/candidates";
import type { SlskdSearchResponse } from "../src/types/upstream";

describe("classifyFile", () => {
  test("classifies audio formats", () => {
    expect(classifyFile("track.flac").kind).toBe("audio");
    expect(classifyFile("track.mp3").kind).toBe("audio");
    expect(classifyFile("track.m4a").kind).toBe("audio");
    expect(classifyFile("track.ogg").kind).toBe("audio");
    expect(classifyFile("track.opus").kind).toBe("audio");
    expect(classifyFile("track.wav").kind).toBe("audio");
    expect(classifyFile("track.ape").kind).toBe("audio");
  });

  test("classifies lyrics", () => {
    expect(classifyFile("track.lrc").kind).toBe("lyrics");
  });

  test("classifies images", () => {
    expect(classifyFile("cover.jpg").kind).toBe("image");
    expect(classifyFile("front.png").kind).toBe("image");
    expect(classifyFile("art.webp").kind).toBe("image");
  });

  test("classifies sidecars", () => {
    expect(classifyFile("album.cue").kind).toBe("cue");
    expect(classifyFile("rip.log").kind).toBe("log");
    expect(classifyFile("info.nfo").kind).toBe("sidecar");
  });

  test("classifies unknown", () => {
    expect(classifyFile("readme.pdf").kind).toBe("other");
  });
});

describe("getExtension", () => {
  test("extracts extension", () => {
    expect(getExtension("file.flac")).toBe(".flac");
    expect(getExtension("file.MP3")).toBe(".mp3");
  });

  test("handles no extension", () => {
    expect(getExtension("README")).toBe("");
  });
});

describe("getParentDirectory", () => {
  test("handles unix paths", () => {
    expect(getParentDirectory("/music/Artist/Album/track.flac")).toBe(
      "/music/Artist/Album"
    );
  });

  test("handles windows paths", () => {
    expect(getParentDirectory("C:\\Music\\Artist\\Album\\track.flac")).toBe(
      "C:/Music/Artist/Album"
    );
  });
});

describe("getFilename", () => {
  test("extracts filename from path", () => {
    expect(getFilename("/music/Artist/Album/01 - Track.flac")).toBe("01 - Track.flac");
    expect(getFilename("C:\\Music\\Album\\track.flac")).toBe("track.flac");
  });
});

describe("groupByDirectory", () => {
  test("groups files by peer and directory", () => {
    const responses: SlskdSearchResponse[] = [
      {
        username: "user1",
        fileCount: 3,
        freeUploadSlots: 1,
        uploadSpeed: 5000000,
        queueLength: 0,
        files: [
          { filename: "/music/Album/01 - Track.flac", size: 30000000 },
          { filename: "/music/Album/02 - Track.flac", size: 35000000 },
          { filename: "/music/Other/song.mp3", size: 5000000 },
        ],
      },
    ];

    const groups = groupByDirectory(responses);
    expect(groups.length).toBe(2);

    const albumGroup = groups.find((g) => g.directory === "/music/Album");
    expect(albumGroup).toBeDefined();
    expect(albumGroup!.files.length).toBe(2);
    expect(albumGroup!.peer).toBe("user1");
  });

  test("multiple peers create separate groups", () => {
    const responses: SlskdSearchResponse[] = [
      {
        username: "user1",
        fileCount: 1,
        freeUploadSlots: 1,
        uploadSpeed: 5000000,
        queueLength: 0,
        files: [{ filename: "/music/Album/track.flac", size: 30000000 }],
      },
      {
        username: "user2",
        fileCount: 1,
        freeUploadSlots: 0,
        uploadSpeed: 1000000,
        queueLength: 5,
        files: [{ filename: "/music/Album/track.flac", size: 30000000 }],
      },
    ];

    const groups = groupByDirectory(responses);
    expect(groups.length).toBe(2);
  });
});

describe("computeStats", () => {
  test("counts audio files and detects format", () => {
    const files: CandidateFile[] = [
      { filename: "01.flac", size: 30000000, kind: "audio", extension: ".flac" },
      { filename: "02.flac", size: 35000000, kind: "audio", extension: ".flac" },
      { filename: "cover.jpg", size: 500000, kind: "image", extension: ".jpg" },
    ];

    const stats = computeStats(files);
    expect(stats.audioFileCount).toBe(2);
    expect(stats.dominantFormat).toBe("FLAC");
    expect(stats.imageCount).toBe(1);
    expect(stats.hasCover).toBe(true);
  });

  test("computes LRC coverage by stem matching", () => {
    const files: CandidateFile[] = [
      { filename: "01 - Angel.flac", size: 30000000, kind: "audio", extension: ".flac" },
      { filename: "02 - Risingson.flac", size: 35000000, kind: "audio", extension: ".flac" },
      { filename: "01 - Angel.lrc", size: 5000, kind: "lyrics", extension: ".lrc" },
      { filename: "02 - Risingson.lrc", size: 4000, kind: "lyrics", extension: ".lrc" },
    ];

    const stats = computeStats(files);
    expect(stats.audioFileCount).toBe(2);
    expect(stats.matchingLrcCount).toBe(2);
    expect(stats.lrcCoverage).toBe(1.0);
  });

  test("unrelated LRC does not get full coverage", () => {
    const files: CandidateFile[] = [
      { filename: "01 - Angel.flac", size: 30000000, kind: "audio", extension: ".flac" },
      { filename: "02 - Risingson.flac", size: 35000000, kind: "audio", extension: ".flac" },
      { filename: "random_lyrics.lrc", size: 5000, kind: "lyrics", extension: ".lrc" },
    ];

    const stats = computeStats(files);
    expect(stats.matchingLrcCount).toBe(0);
    expect(stats.lrcCoverage).toBe(0);
  });
});

describe("selectDownloadFiles", () => {
  test("selects audio, matching LRC, and images", () => {
    const files: CandidateFile[] = [
      { filename: "01 - Angel.flac", size: 30000000, kind: "audio", extension: ".flac" },
      { filename: "01 - Angel.lrc", size: 5000, kind: "lyrics", extension: ".lrc" },
      { filename: "cover.jpg", size: 500000, kind: "image", extension: ".jpg" },
      { filename: "random.txt", size: 100, kind: "lyrics", extension: ".txt" },
      { filename: "info.nfo", size: 200, kind: "sidecar", extension: ".nfo" },
    ];

    const selected = selectDownloadFiles(files);
    // audio + matching lrc + image = 3, not the .txt or .nfo
    expect(selected.some((f) => f.filename === "01 - Angel.flac")).toBe(true);
    expect(selected.some((f) => f.filename === "01 - Angel.lrc")).toBe(true);
    expect(selected.some((f) => f.filename === "cover.jpg")).toBe(true);
  });
});
