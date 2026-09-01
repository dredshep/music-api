import { describe, expect, test } from "bun:test";
import { toLegacyOwnershipPayload } from "../src/routes/navidrome-matches";

describe("legacy Navidrome ownership compatibility", () => {
  test("maps new match vocabulary back to the legacy ownership contract", () => {
    const payload = toLegacyOwnershipPayload({
      results: [
        { id: "a", status: "matched", confidence: 1, match: null },
        { id: "b", status: "possible_match", confidence: 0.8, match: null },
        { id: "c", status: "not_found", confidence: 0.1, match: null },
        { id: "d", status: "unchecked", confidence: 0, match: null },
      ],
      summary: { matched: 1, possible_match: 1, not_found: 1, unchecked: 1 },
      snapshot_version: "v1",
      snapshot_built_at: "2026-09-02T00:00:00.000Z",
      snapshot_total: 4,
      snapshot_stale: false,
      snapshot_rebuild_error: null,
      snapshot: null,
    });

    expect(payload.results.map((result) => result.status)).toEqual([
      "owned",
      "uncertain",
      "missing",
      "unknown",
    ]);
    expect(payload.summary).toEqual({
      owned: 1,
      uncertain: 1,
      missing: 1,
      unknown: 1,
    });
    expect(payload.snapshot_version).toBe("v1");
  });
});
