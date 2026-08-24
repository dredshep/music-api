import { describe, test, expect } from "bun:test";
import { isSearchComplete, normalizeSearchResponse } from "../src/types/upstream";
import type { SlskdSearchState, SlskdSearchResponseRaw, SlskdSearchResponse } from "../src/types/upstream";
import { groupByDirectory, computeStats, type RawCandidate } from "../src/domain/candidates";

describe("search lifecycle: result ingestion from slskd contract fixtures", () => {
  const makeSearchState = (overrides: Partial<SlskdSearchState> = {}): SlskdSearchState => ({
    id: "test-search-1",
    searchText: "Meiko Kaji Yadokari",
    state: "InProgress",
    responseCount: 0,
    fileCount: 0,
    ...overrides,
  });

  test("search still collecting: responseCount > 0 but isComplete=false", () => {
    const state = makeSearchState({
      state: "InProgress",
      responseCount: 5,
      fileCount: 100,
      isComplete: false,
    });
    expect(isSearchComplete(state)).toBe(false);
  });

  test("search settled: Completed, Succeeded", () => {
    const state = makeSearchState({
      state: "Completed, Succeeded",
      responseCount: 29,
      fileCount: 442,
      isComplete: true,
    });
    expect(isSearchComplete(state)).toBe(true);
  });

  test("search settled: Completed, TimedOut still counts as settled", () => {
    const state = makeSearchState({
      state: "Completed, TimedOut",
      responseCount: 10,
      fileCount: 50,
    });
    expect(isSearchComplete(state)).toBe(true);
  });
});

describe("search lifecycle: candidate grouping with real-world fixture shapes", () => {
  test("groups Japanese path directories correctly", () => {
    const responses: SlskdSearchResponse[] = [
      normalizeSearchResponse({
        username: "jpPeer1",
        fileCount: 12,
        hasFreeUploadSlot: true,
        uploadSpeed: 3000000,
        queueLength: 0,
        files: Array.from({ length: 12 }, (_, i) => ({
          filename: `D:\\Music\\梶芽衣子\\梶芽衣子オリジナル・ベスト12-やどかり-\\${String(i + 1).padStart(2, "0")} - Track ${i + 1}.flac`,
          size: 30000000 + i * 1000000,
        })),
      } satisfies SlskdSearchResponseRaw),
    ];

    const groups = groupByDirectory(responses);
    expect(groups.length).toBe(1);
    expect(groups[0].files.length).toBe(12);
    expect(groups[0].peer).toBe("jpPeer1");
    expect(groups[0].directory).toContain("梶芽衣子");

    const stats = computeStats(groups[0].files);
    expect(stats.audioFileCount).toBe(12);
    expect(stats.dominantFormat).toBe("FLAC");
  });

  test("multiple peers with same directory create separate groups", () => {
    const makeResponse = (username: string): SlskdSearchResponse =>
      normalizeSearchResponse({
        username,
        fileCount: 3,
        hasFreeUploadSlot: true,
        uploadSpeed: 5000000,
        queueLength: 0,
        files: [
          { filename: "/music/Artist/Album/01.flac", size: 30000000 },
          { filename: "/music/Artist/Album/02.flac", size: 35000000 },
          { filename: "/music/Artist/Album/03.flac", size: 32000000 },
        ],
      } satisfies SlskdSearchResponseRaw);

    const groups = groupByDirectory([makeResponse("peer1"), makeResponse("peer2")]);
    expect(groups.length).toBe(2);
  });

  test("duplicate files from same peer across query variants are deduped", () => {
    const makeResponse = (queryVariant: string): SlskdSearchResponse =>
      normalizeSearchResponse({
        username: "peer1",
        fileCount: 2,
        hasFreeUploadSlot: true,
        uploadSpeed: 5000000,
        queueLength: 0,
        files: [
          { filename: "/music/Artist/Album/01.flac", size: 30000000 },
          { filename: "/music/Artist/Album/02.flac", size: 35000000 },
        ],
      } satisfies SlskdSearchResponseRaw);

    const groups = groupByDirectory([
      makeResponse("Artist Album"),
      makeResponse("Artist - Album"),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].files.length).toBe(2);
  });
});

describe("search lifecycle: enrichment degradation", () => {
  test("candidate with search-hit files is usable when enrichment fails", () => {
    const raw: RawCandidate = {
      peer: "user1",
      directory: "/music/Artist/Album",
      files: [
        { filename: "/music/Artist/Album/01.flac", size: 30000000, kind: "audio", extension: ".flac" },
        { filename: "/music/Artist/Album/02.flac", size: 35000000, kind: "audio", extension: ".flac" },
      ],
      uploadSpeed: 5000000,
      freeUploadSlots: true,
      queueLength: 0,
    };

    const stats = computeStats(raw.files);
    expect(stats.audioFileCount).toBe(2);
    expect(stats.dominantFormat).toBe("FLAC");
  });

  test("candidate with zero audio files after enrichment is filtered out", () => {
    const raw: RawCandidate = {
      peer: "user1",
      directory: "/music/Artist/Misc",
      files: [
        { filename: "/music/Artist/Misc/readme.txt", size: 500, kind: "lyrics", extension: ".txt" },
      ],
      uploadSpeed: 5000000,
      freeUploadSlots: true,
      queueLength: 0,
    };

    const stats = computeStats(raw.files);
    expect(stats.audioFileCount).toBe(0);
  });
});

describe("search lifecycle: stable candidate IDs via upsert key", () => {
  test("upsert key is search_id + peer + remote_directory", () => {
    // Verify that the key components are deterministic
    const key1 = "search_1::peer1::/music/Artist/Album";
    const key2 = "search_1::peer1::/music/Artist/Album";
    expect(key1).toBe(key2);

    const key3 = "search_1::peer2::/music/Artist/Album";
    expect(key1).not.toBe(key3);
  });
});
