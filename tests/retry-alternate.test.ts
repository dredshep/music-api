import { describe, test, expect } from "bun:test";
import { planAlternatePeerRetry } from "../src/domain/retry-alternate";
import { normalizeSearchResponse } from "../src/types/upstream";
import type { SlskdSearchResponseRaw } from "../src/types/upstream";

describe("planAlternatePeerRetry", () => {
  const failedFiles = Array.from({ length: 14 }, (_, i) => ({
    logical_filename: `${String(i + 1).padStart(2, "0")} Track ${i + 1}.flac`,
    kind: "audio",
  }));

  test("finds alternate peer and matches failed release files", () => {
    const alternate = normalizeSearchResponse({
      username: "alt-peer",
      fileCount: 14,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: failedFiles.map((f) => ({
        filename: `music\\Fcukers\\${f.logical_filename}`,
        size: 30_000_000,
      })),
    } satisfies SlskdSearchResponseRaw);

    const original = normalizeSearchResponse({
      username: "dj-popparon",
      fileCount: 14,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: failedFiles.map((f) => ({
        filename: `music\\Fcukers\\${f.logical_filename}`,
        size: 30_000_000,
      })),
    } satisfies SlskdSearchResponseRaw);

    const plan = planAlternatePeerRetry({
      originalPeer: "dj-popparon",
      retryableFiles: failedFiles,
      responses: [original, alternate],
    });

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.alternatePeer).toBe("alt-peer");
      expect(plan.filesToEnqueue.length).toBe(14);
    }
  });

  test("returns no_alternate_peers when only original peer responded", () => {
    const original = normalizeSearchResponse({
      username: "dj-popparon",
      fileCount: 1,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [{ filename: "music\\Fcukers\\01 Beatback.flac", size: 30_000_000 }],
    } satisfies SlskdSearchResponseRaw);

    const plan = planAlternatePeerRetry({
      originalPeer: "dj-popparon",
      retryableFiles: [{ logical_filename: "01 Beatback.flac", kind: "audio" }],
      responses: [original],
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe("no_alternate_peers");
    }
  });

  test("returns no_file_matches when alternate peer lacks compatible names", () => {
    const alternate = normalizeSearchResponse({
      username: "other-peer",
      fileCount: 1,
      hasFreeUploadSlot: true,
      uploadSpeed: 5000000,
      queueLength: 0,
      files: [{ filename: "music\\Other\\totally-different.flac", size: 30_000_000 }],
    } satisfies SlskdSearchResponseRaw);

    const plan = planAlternatePeerRetry({
      originalPeer: "dj-popparon",
      retryableFiles: [{ logical_filename: "01 Beatback.flac", kind: "audio" }],
      responses: [alternate],
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe("no_file_matches");
    }
  });
});

describe("service reference guard", () => {
  test("check-service-refs script passes", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/check-service-refs.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exit).toBe(0);
    if (exit !== 0) {
      console.error(stderr);
    }
  });
});
