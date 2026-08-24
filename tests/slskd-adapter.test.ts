import { describe, test, expect } from "bun:test";
import {
  normalizeSearchResponse,
  isSearchComplete,
  type SlskdSearchResponseRaw,
  type SlskdSearchState,
} from "../src/types/upstream";

describe("normalizeSearchResponse", () => {
  test("normalizes hasFreeUploadSlot boolean to freeUploadSlots number", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 5,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.freeUploadSlots).toBe(1);
    expect(result.lockedFiles).toEqual([]);
    expect(result.lockedFileCount).toBe(0);
  });

  test("normalizes hasFreeUploadSlot=false to 0", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 3,
      hasFreeUploadSlot: false,
      uploadSpeed: 1000000,
      queueLength: 10,
      files: [],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.freeUploadSlots).toBe(0);
  });

  test("falls back to legacy freeUploadSlots number", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 5,
      freeUploadSlots: 3,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.freeUploadSlots).toBe(3);
  });

  test("hasFreeUploadSlot takes priority over freeUploadSlots", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 5,
      hasFreeUploadSlot: false,
      freeUploadSlots: 5,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.freeUploadSlots).toBe(0);
  });

  test("defaults to 0 when neither field present", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 5,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.freeUploadSlots).toBe(0);
  });

  test("handles lockedFiles array", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 2,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [{ filename: "file1.flac", size: 30000000 }],
      lockedFiles: [
        { filename: "locked1.flac", size: 25000000 },
        { filename: "locked2.flac", size: 28000000 },
      ],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.lockedFiles.length).toBe(2);
    expect(result.lockedFileCount).toBe(2);
  });

  test("handles lockedFileCount without lockedFiles array", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "peer1",
      fileCount: 2,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [],
      lockedFileCount: 7,
    };
    const result = normalizeSearchResponse(raw);
    expect(result.lockedFileCount).toBe(7);
    expect(result.lockedFiles).toEqual([]);
  });

  test("handles missing/null uploadSpeed and queueLength gracefully", () => {
    const raw = {
      username: "peer1",
      fileCount: 1,
      hasFreeUploadSlot: true,
      files: [{ filename: "track.flac", size: 10000 }],
    } as unknown as SlskdSearchResponseRaw;
    const result = normalizeSearchResponse(raw);
    expect(result.uploadSpeed).toBe(0);
    expect(result.queueLength).toBe(0);
    expect(result.files.length).toBe(1);
  });

  test("handles files being undefined/null", () => {
    const raw = {
      username: "peer1",
      fileCount: 0,
      hasFreeUploadSlot: true,
      uploadSpeed: 1000,
      queueLength: 0,
      files: null,
    } as unknown as SlskdSearchResponseRaw;
    const result = normalizeSearchResponse(raw);
    expect(result.files).toEqual([]);
  });
});

describe("isSearchComplete", () => {
  test("isComplete=true is settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "InProgress",
      responseCount: 0,
      fileCount: 0,
      isComplete: true,
    };
    expect(isSearchComplete(state)).toBe(true);
  });

  test("Completed state string is settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "Completed",
      responseCount: 5,
      fileCount: 20,
    };
    expect(isSearchComplete(state)).toBe(true);
  });

  test("Completed, Succeeded is settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "Completed, Succeeded",
      responseCount: 5,
      fileCount: 20,
    };
    expect(isSearchComplete(state)).toBe(true);
  });

  test("Completed, TimedOut is settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "Completed, TimedOut",
      responseCount: 3,
      fileCount: 10,
    };
    expect(isSearchComplete(state)).toBe(true);
  });

  test("InProgress is not settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "InProgress",
      responseCount: 2,
      fileCount: 10,
    };
    expect(isSearchComplete(state)).toBe(false);
  });

  test("empty state is not settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "",
      responseCount: 0,
      fileCount: 0,
    };
    expect(isSearchComplete(state)).toBe(false);
  });

  test("isComplete=false with InProgress state is not settled", () => {
    const state: SlskdSearchState = {
      id: "s1",
      searchText: "test",
      state: "InProgress",
      responseCount: 5,
      fileCount: 100,
      isComplete: false,
    };
    expect(isSearchComplete(state)).toBe(false);
  });
});

describe("slskd response with Japanese paths", () => {
  test("normalizes response with Unicode filenames", () => {
    const raw: SlskdSearchResponseRaw = {
      username: "jpUser",
      fileCount: 2,
      hasFreeUploadSlot: true,
      uploadSpeed: 3000000,
      queueLength: 0,
      files: [
        { filename: "D:\\Music\\梶芽衣子\\やどかり\\01 - 花咲く蕾.flac", size: 40000000 },
        { filename: "D:\\Music\\梶芽衣子\\やどかり\\02 - やどかり.flac", size: 35000000 },
      ],
      lockedFiles: [
        { filename: "D:\\Music\\梶芽衣子\\やどかり\\cover.jpg", size: 100000 },
      ],
    };
    const result = normalizeSearchResponse(raw);
    expect(result.files.length).toBe(2);
    expect(result.lockedFiles.length).toBe(1);
    expect(result.lockedFileCount).toBe(1);
    expect(result.files[0].filename).toContain("梶芽衣子");
  });
});
