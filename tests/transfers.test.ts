import { describe, test, expect } from "bun:test";
import {
  mapSlskdFileState,
  deriveJobStatus,
  computeProgress,
  mapTransferError,
  isRetryable,
} from "../src/domain/transfers";
import type { FileStatus } from "../src/types/api";

describe("mapSlskdFileState", () => {
  test("maps Completed, Succeeded to completed", () => {
    expect(mapSlskdFileState("Completed, Succeeded")).toBe("completed");
  });

  test("maps Completed, Aborted to failed", () => {
    expect(mapSlskdFileState("Completed, Aborted")).toBe("failed");
  });

  test("maps Completed, Cancelled to cancelled", () => {
    expect(mapSlskdFileState("Completed, Cancelled")).toBe("cancelled");
  });

  test("maps Completed, Errored to failed", () => {
    expect(mapSlskdFileState("Completed, Errored")).toBe("failed");
  });

  test("maps InProgress to downloading", () => {
    expect(mapSlskdFileState("InProgress")).toBe("downloading");
  });

  test("maps Initializing to downloading", () => {
    expect(mapSlskdFileState("Initializing")).toBe("downloading");
  });

  test("maps Queued, Locally to queued", () => {
    expect(mapSlskdFileState("Queued, Locally")).toBe("queued");
  });

  test("maps Queued, Remotely to waiting_remote", () => {
    expect(mapSlskdFileState("Queued, Remotely")).toBe("waiting_remote");
  });

  test("handles case insensitivity", () => {
    expect(mapSlskdFileState("COMPLETED, SUCCEEDED")).toBe("completed");
    expect(mapSlskdFileState("inprogress")).toBe("downloading");
  });
});

describe("deriveJobStatus", () => {
  test("all completed = completed", () => {
    const statuses: FileStatus[] = ["completed", "completed", "completed"];
    expect(deriveJobStatus(statuses)).toBe("completed");
  });

  test("all failed = failed", () => {
    const statuses: FileStatus[] = ["failed", "failed"];
    expect(deriveJobStatus(statuses)).toBe("failed");
  });

  test("some completed some failed no active = partial_failure", () => {
    const statuses: FileStatus[] = ["completed", "completed", "failed"];
    expect(deriveJobStatus(statuses)).toBe("partial_failure");
  });

  test("something downloading = downloading", () => {
    const statuses: FileStatus[] = ["completed", "downloading", "queued"];
    expect(deriveJobStatus(statuses)).toBe("downloading");
  });

  test("all queued = queued", () => {
    const statuses: FileStatus[] = ["queued", "queued"];
    expect(deriveJobStatus(statuses)).toBe("queued");
  });

  test("empty = queued", () => {
    expect(deriveJobStatus([])).toBe("queued");
  });

  test("waiting_remote counts as active", () => {
    const statuses: FileStatus[] = ["completed", "waiting_remote"];
    expect(deriveJobStatus(statuses)).toBe("downloading");
  });
});

describe("computeProgress", () => {
  test("all completed = 1.0", () => {
    const files = [
      { status: "completed" as FileStatus },
      { status: "completed" as FileStatus },
    ];
    expect(computeProgress(files)).toBe(1.0);
  });

  test("none completed = 0", () => {
    const files = [
      { status: "queued" as FileStatus },
      { status: "queued" as FileStatus },
    ];
    expect(computeProgress(files)).toBe(0);
  });

  test("half completed = 0.5", () => {
    const files = [
      { status: "completed" as FileStatus },
      { status: "queued" as FileStatus },
    ];
    expect(computeProgress(files)).toBe(0.5);
  });

  test("empty = 0", () => {
    expect(computeProgress([])).toBe(0);
  });
});

describe("mapTransferError", () => {
  test("maps aborted", () => {
    expect(mapTransferError("Completed, Aborted")).toBe("transfer_aborted");
  });

  test("maps rejected", () => {
    expect(mapTransferError("Completed, Rejected")).toBe("peer_rejected");
  });

  test("maps timeout", () => {
    expect(mapTransferError("Completed, TimedOut")).toBe("timeout");
  });
});

describe("isRetryable", () => {
  test("failed is retryable", () => {
    expect(isRetryable("failed")).toBe(true);
  });

  test("cancelled is retryable", () => {
    expect(isRetryable("cancelled")).toBe(true);
  });

  test("completed is not retryable", () => {
    expect(isRetryable("completed")).toBe(false);
  });

  test("downloading is not retryable", () => {
    expect(isRetryable("downloading")).toBe(false);
  });
});
