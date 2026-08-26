import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { log } from "../middleware/logging";
import * as slskd from "../services/slskd";
import {
  getJob,
  incrementJobAttempt,
  updateJobStatus,
} from "../db/repositories/jobs";
import {
  getJobFile,
  getJobFiles,
  updateJobFilePeer,
  updateJobFileStatus,
} from "../db/repositories/job-files";
import { deriveJobStatus } from "../domain/transfers";
import { syncJobFromSlskd } from "../domain/sync-transfers";
import type { FileStatus, JobStatus } from "../types/api";

export const downloadFileControlRoutes = new Hono();

const controlSchema = z.object({
  action: z.enum(["cancel", "retry"]),
});

function aggregateJobStatus(statuses: FileStatus[]): JobStatus {
  if (statuses.length > 0 && statuses.every((status) => status === "cancelled")) {
    return "cancelled";
  }

  const terminal = statuses.every((status) =>
    ["completed", "failed", "cancelled"].includes(status)
  );
  if (
    terminal &&
    statuses.some((status) => status === "completed") &&
    statuses.some((status) => status === "failed" || status === "cancelled")
  ) {
    return "partial_failure";
  }

  return deriveJobStatus(statuses);
}

async function syncBestEffort(jobId: string) {
  try {
    await syncJobFromSlskd(jobId);
  } catch (error) {
    log("warn", "download_file_sync_failed", {
      job_id: jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

downloadFileControlRoutes.get("/downloads/:job_id/files", async (c) => {
  const jobId = c.req.param("job_id");
  const job = getJob(jobId);
  if (!job) throw new AppError("DOWNLOAD_NOT_FOUND", "Download job not found", 404);

  await syncBestEffort(jobId);

  return c.json({
    job_id: jobId,
    files: getJobFiles(jobId).map((file) => ({
      file_id: file.id,
      filename: file.logical_filename,
      remote_path: file.remote_filename,
      kind: file.kind,
      size: file.size,
      status: file.status,
      peer: file.current_peer,
      error: file.last_error ?? undefined,
    })),
  });
});

downloadFileControlRoutes.post(
  "/downloads/:job_id/files/:file_id/control",
  async (c) => {
    const jobId = c.req.param("job_id");
    const fileId = c.req.param("file_id");
    const job = getJob(jobId);
    if (!job) throw new AppError("DOWNLOAD_NOT_FOUND", "Download job not found", 404);

    const parsed = controlSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        parsed.error.issues.map((issue) => issue.message).join("; "),
        400
      );
    }

    await syncBestEffort(jobId);
    const file = getJobFile(jobId, fileId);
    if (!file) throw new AppError("DOWNLOAD_NOT_FOUND", "Download file not found", 404);

    if (parsed.data.action === "cancel") {
      if (file.status === "completed") {
        throw new AppError(
          "INVALID_DOWNLOAD_STATE",
          "Completed files cannot be cancelled",
          409
        );
      }

      if (
        ["queued", "waiting_remote", "downloading"].includes(file.status) &&
        file.slskd_transfer_id &&
        file.current_peer
      ) {
        try {
          await slskd.cancelTransfer(file.current_peer, file.slskd_transfer_id);
        } catch (error) {
          log("warn", "download_file_cancel_remote_failed", {
            job_id: jobId,
            file_id: fileId,
            peer: file.current_peer,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      updateJobFileStatus(file.id, "cancelled");
      const statuses = getJobFiles(jobId).map((row) => row.status as FileStatus);
      const jobStatus = aggregateJobStatus(statuses);
      updateJobStatus(jobId, jobStatus);

      log("info", "download_file_cancelled", {
        job_id: jobId,
        file_id: file.id,
        filename: file.logical_filename,
        job_status: jobStatus,
      });

      return c.json({
        job_id: jobId,
        file_id: file.id,
        filename: file.logical_filename,
        status: "cancelled",
        job_status: jobStatus,
      });
    }

    if (!["failed", "cancelled"].includes(file.status)) {
      throw new AppError(
        "INVALID_DOWNLOAD_STATE",
        `File is not retryable while status is ${file.status}`,
        409
      );
    }

    const peer = file.current_peer ?? file.original_peer ?? job.peer;
    if (!peer) throw new AppError("PEER_OFFLINE", "No peer available for retry", 502, true);

    await slskd.enqueueFiles(peer, [
      { filename: file.remote_filename, size: file.size ?? 0 },
    ]);
    updateJobFilePeer(file.id, peer);
    updateJobFileStatus(file.id, "queued");
    updateJobStatus(jobId, "retrying");
    incrementJobAttempt(jobId);

    log("info", "download_file_retry", {
      job_id: jobId,
      file_id: file.id,
      filename: file.logical_filename,
      peer,
    });

    return c.json({
      job_id: jobId,
      file_id: file.id,
      filename: file.logical_filename,
      status: "queued",
      job_status: "retrying",
      peer,
    });
  }
);
