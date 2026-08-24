import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import * as slskd from "../services/slskd";
import { getJob, updateJobStatus } from "../db/repositories/jobs";
import { getJobFiles, updateJobFileStatus } from "../db/repositories/job-files";

export const downloadFileControlRoutes = new Hono();

const schema = z.object({
  action: z.enum(["cancel", "retry"]),
  filename: z.string().min(1).max(2000),
});

downloadFileControlRoutes.post("/downloads/:job_id/files/control", async (c) => {
  const jobId = c.req.param("job_id");
  const job = getJob(jobId);
  if (!job) throw new AppError("DOWNLOAD_NOT_FOUND", "Download job not found", 404);

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((issue) => issue.message).join("; "),
      400
    );
  }

  const file = getJobFiles(jobId).find(
    (row) => row.logical_filename === parsed.data.filename
  );
  if (!file) throw new AppError("DOWNLOAD_NOT_FOUND", "Download file not found", 404);

  if (parsed.data.action === "cancel") {
    if (
      ["queued", "waiting_remote", "downloading"].includes(file.status) &&
      file.slskd_transfer_id &&
      file.current_peer
    ) {
      try {
        await slskd.cancelTransfer(file.current_peer, file.slskd_transfer_id);
      } catch {
        // The logical file still becomes cancelled; slskd may already have removed it.
      }
    }
    updateJobFileStatus(file.id, "cancelled");
    return c.json({ job_id: jobId, filename: file.logical_filename, status: "cancelled" });
  }

  if (!["failed", "cancelled"].includes(file.status)) {
    return c.json({
      job_id: jobId,
      filename: file.logical_filename,
      status: file.status,
      message: "File is not retryable in its current state",
    });
  }

  const peer = file.current_peer ?? file.original_peer ?? job.peer;
  if (!peer) throw new AppError("PEER_OFFLINE", "No peer available for retry", 502, true);

  await slskd.enqueueFiles(peer, [
    { filename: file.remote_filename, size: file.size ?? 0 },
  ]);
  updateJobFileStatus(file.id, "queued");
  updateJobStatus(jobId, "retrying");

  return c.json({
    job_id: jobId,
    filename: file.logical_filename,
    status: "queued",
    peer,
  });
});
