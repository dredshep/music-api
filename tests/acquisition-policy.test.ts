import { describe, expect, test } from "bun:test";
import {
  hasSameSourceRetryBudget,
  isSystemicSourceFailure,
  selectNextAcquisitionCandidate,
} from "../src/domain/acquisition-policy";

describe("acquisition policy", () => {
  test("treats an all-zero timeout/error release as a systemic source failure", () => {
    const files = [
      ...Array.from({ length: 9 }, () => ({ status: "failed", attempts: 0, last_error: "timeout" })),
      { status: "failed", attempts: 0, last_error: "transfer_error" },
    ];
    expect(isSystemicSourceFailure(files)).toBe(true);
  });

  test("does not abandon a mostly successful source because one file timed out", () => {
    const files = [
      ...Array.from({ length: 9 }, () => ({ status: "completed", attempts: 0, last_error: null })),
      { status: "failed", attempts: 1, last_error: "timeout" },
    ];
    expect(isSystemicSourceFailure(files)).toBe(false);
    expect(hasSameSourceRetryBudget(files, 3)).toBe(true);
  });

  test("stops same-source retry after the retry budget is exhausted", () => {
    const files = [
      { status: "completed", attempts: 0, last_error: null },
      { status: "failed", attempts: 3, last_error: "timeout" },
    ];
    expect(hasSameSourceRetryBudget(files, 3)).toBe(false);
  });

  test("chooses the highest-scored fresh candidate not already attempted or on a blocked peer", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const candidates = [
      { id: "a", peer: "dead-peer", score: 100, expires_at: future, files_json: "[]" },
      { id: "b", peer: "also-tried", score: 95, expires_at: future, files_json: "[]" },
      { id: "c", peer: "good-peer", score: 90, expires_at: future, files_json: "[]" },
      { id: "d", peer: "other-peer", score: 80, expires_at: future, files_json: "[]" },
    ];

    expect(
      selectNextAcquisitionCandidate(candidates, ["b"], ["dead-peer"])?.id
    ).toBe("c");
  });

  test("never reuses expired candidates", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const candidates = [
      { id: "expired", peer: "peer", score: 100, expires_at: past, files_json: "[]" },
    ];
    expect(selectNextAcquisitionCandidate(candidates, [], [])).toBeNull();
  });
});
