import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { log } from "../middleware/logging";
import * as slskd from "../services/slskd";
import {
  getCandidate,
  isCandidateExpired,
} from "../db/repositories/candidates";
import {
  createJob,
  getJob,
  getJobByCandidateId,
  listJobs,
  updateJobStatus,
  incrementJobAttempt,
} from "../db/repositories/jobs";
import {
  createJobFiles,
  getJobFiles,
  getRetryableJobFiles,
  getJobFileStats,
  updateJobFileStatus,
  updateJobFileTransferId,
  failAllJobFiles,
} from "../db/repositories/job-files";
import {
  selectDownloadFiles,
  getFilename,
  type CandidateFile,
} from "../domain/candidates";
import { deriveJobStatus, computeProgress } from "../domain/transfers";
import {
  syncJobFromSlskd,
  syncActiveJobsFromSlskd,
} from "../domain/sync-transfers";
import type { FileKind, FileStatus } from "../types/api";

export const downloadRoutes = new Hono();

const enqueueSchema = z.object({
  candidate_id: z.string().min(1).max(100),
});

downloadRoutes.post("/downloads", async (c) => {
  const body = await c.req.json();
  const parsed = enqueueSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { candidate_id } = parsed.data;

  // Check for existing active job (idempotency)
  const existingJob = getJobByCandidateId(candidate_id);
  if (existingJob) {
    return c.json({
      job_id: existingJob.id,
      status: "already_queued",
    });
  }

  // Load candidate
  const candidate = getCandidate(candidate_id);
  if (!candidate) {
    throw new AppError("CANDIDATE_NOT_FOUND", "Candidate not found", 404);
  }

  if (isCandidateExpired(candidate)) {
    throw new AppError(
      "CANDIDATE_EXPIRED",
      "The search candidate has expired. Run the search again.",
      410
    );
  }

  // Parse stored files
  const storedFiles: CandidateFile[] = candidate.files_json
    ? JSON.parse(candidate.files_json)
    : [];

  if (storedFiles.length === 0) {
    throw new AppError(
      "CANDIDATE_NOT_FOUND",
      "Candidate has no stored file manifest",
      400
    );
  }

  // Select files for download
  const filesToDownload = selectDownloadFiles(storedFiles);

  // Create job
  const job = createJob({
    candidateId: candidate.id,
    artist: candidate.display_release?.split(" - ")[0],
    releaseTitle: candidate.display_release?.split(" - ").slice(1).join(" - "),
    selectedFormat: candidate.format ?? undefined,
    peer: candidate.peer,
    remoteDirectory: candidate.remote_directory,
    originalQuery: {
      search_id: candidate.search_id,
      peer: candidate.peer,
      directory: candidate.remote_directory,
    },
  });

  // Create file records
  const fileParams = filesToDownload.map((f) => ({
    jobId: job.id,
    logicalFilename: getFilename(f.filename),
    remoteFilename: f.filename,
    size: f.size,
    kind: f.kind as FileKind,
    peer: candidate.peer,
  }));

  createJobFiles(fileParams);

  // Enqueue through slskd
  try {
    const remoteFiles = filesToDownload.map((f) => ({
      filename: f.filename,
      size: f.size,
    }));

    await slskd.enqueueFiles(candidate.peer, remoteFiles);
    updateJobStatus(job.id, "downloading");

    log("info", "download_enqueued", {
      job_id: job.id,
      peer: candidate.peer,
      files: filesToDownload.length,
      audio_files: filesToDownload.filter((f) => f.kind === "audio").length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "enqueue failed for unknown reason";
    failAllJobFiles(job.id, message);
    updateJobStatus(job.id, "failed", message);

    log("warn", "download_enqueue_failed", {
      job_id: job.id,
      peer: candidate.peer,
      files: filesToDownload.length,
      error: message,
    });

    throw err;
  }

  const audioFiles = filesToDownload.filter((f) => f.kind === "audio");
  const lyricsFiles = filesToDownload.filter((f) => f.kind === "lyrics");

  return c.json(
    {
      job_id: job.id,
      status: "queued",
      artist: job.artist,
      release: job.release_title,
      files: filesToDownload.length,
      audio_files: audioFiles.length,
      lyrics_files: lyricsFiles.length,
    },
    201
  );
});

downloadRoutes.get("/downloads", async (c) => {
  const status = c.req.query("status") ?? "active";
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  // Refresh logical jobs from live slskd transfer state before reading
  if (status === "active" || status === "all") {
    try {
      await syncActiveJobsFromSlskd();
    } catch (err) {
      log("warn", "download_sync_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const jobs = listJobs({ status, limit });

  const jobsWithStats = jobs.map((job) => {
    const stats = getJobFileStats(job.id);
    const fileStatuses = getJobFiles(job.id).map((f) => f.status as FileStatus);
    const progress = computeProgress(
      fileStatuses.map((s) => ({ status: s }))
    );

    return {
      job_id: job.id,
      artist: job.artist,
      release: job.release_title,
      status: job.status,
      error: job.last_error ?? undefined,
      files: {
        total: stats.total,
        completed: stats.completed,
        downloading: stats.downloading,
        queued: stats.queued,
        failed: stats.failed,
      },
      progress: Math.round(progress * 100) / 100,
      created_at: job.created_at,
    };
  });

  return c.json({ jobs: jobsWithStats });
});

downloadRoutes.get("/downloads/:job_id", async (c) => {
  const jobId = c.req.param("job_id");

  try {
    await syncJobFromSlskd(jobId);
  } catch (err) {
    log("warn", "download_sync_failed", {
      job_id: jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const job = getJob(jobId);
  if (!job) {
    throw new AppError("DOWNLOAD_NOT_FOUND", "Download job not found", 404);
  }

  const files = getJobFiles(jobId);
  const stats = getJobFileStats(jobId);
  const fileStatuses = files.map((f) => f.status as FileStatus);
  const progress = computeProgress(fileStatuses.map((s) => ({ status: s })));

  const failures = files
    .filter((f) => f.status === "failed")
    .map((f) => ({
      filename: f.logical_filename,
      kind: f.kind,
      reason: f.last_error ?? "unknown",
    }));

  return c.json({
    job_id: job.id,
    artist: job.artist,
    release: job.release_title,
    status: job.status,
    error: job.last_error ?? undefined,
    peer: job.peer ?? undefined,
    remote_directory: job.remote_directory ?? undefined,
    files: {
      total: stats.total,
      completed: stats.completed,
      downloading: stats.downloading,
      queued: stats.queued,
      failed: stats.failed,
    },
    progress: Math.round(progress * 100) / 100,
    file_list: files.map((f) => ({
      filename: f.logical_filename,
      remote_path: f.remote_filename,
      kind: f.kind,
      size: f.size,
      status: f.status,
      peer: f.current_peer,
      error: f.last_error ?? undefined,
    })),
    failures: failures.length > 0 ? failures : undefined,
    created_at: job.created_at,
  });
});

const controlSchema = z.object({
  action: z.enum(["cancel", "retry", "retry_alternate"]),
});

downloadRoutes.post("/downloads/:job_id/control", async (c) => {
  const jobId = c.req.param("job_id");
  const body = await c.req.json();
  const parsed = controlSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { action } = parsed.data;
  const job = getJob(jobId);

  if (!job) {
    throw new AppError("DOWNLOAD_NOT_FOUND", "Download job not found", 404);
  }

  switch (action) {
    case "cancel":
      return await handleCancel(c, job);
    case "retry":
      return await handleRetry(c, job);
    case "retry_alternate":
      return await handleRetryAlternate(c, job);
  }
});

async function handleCancel(
  c: Parameters<Parameters<typeof downloadRoutes.post>[1]>[0],
  job: ReturnType<typeof getJob> & {}
) {
  const files = getJobFiles(job.id);

  // Cancel active transfers
  for (const file of files) {
    if (
      file.status === "queued" ||
      file.status === "downloading" ||
      file.status === "waiting_remote"
    ) {
      if (file.slskd_transfer_id && file.current_peer) {
        try {
          await slskd.cancelTransfer(file.current_peer, file.slskd_transfer_id);
        } catch {
          // Best-effort cancellation
        }
      }
      updateJobFileStatus(file.id, "cancelled");
    }
  }

  updateJobStatus(job.id, "cancelled");

  return c.json({
    job_id: job.id,
    status: "cancelled",
  });
}

async function handleRetry(
  c: Parameters<Parameters<typeof downloadRoutes.post>[1]>[0],
  job: ReturnType<typeof getJob> & {}
) {
  const retryableFiles = getRetryableJobFiles(job.id);

  if (retryableFiles.length === 0) {
    return c.json({
      job_id: job.id,
      status: job.status,
      message: "No retryable files found",
    });
  }

  // Re-enqueue failed files
  const filesToRetry = retryableFiles.map((f) => ({
    filename: f.remote_filename,
    size: f.size ?? 0,
  }));

  const peer = job.peer ?? retryableFiles[0]?.current_peer;
  if (!peer) {
    throw new AppError("PEER_OFFLINE", "No peer available for retry", 502, true);
  }

  await slskd.enqueueFiles(peer, filesToRetry);

  for (const file of retryableFiles) {
    updateJobFileStatus(file.id, "queued");
  }

  updateJobStatus(job.id, "retrying");
  incrementJobAttempt(job.id);

  log("info", "download_retry", {
    job_id: job.id,
    files_retried: retryableFiles.length,
    peer,
  });

  return c.json({
    job_id: job.id,
    status: "retrying",
    retry: {
      strategy: "same_peer",
      failed_files: retryableFiles.length,
    },
  });
}

async function handleRetryAlternate(
  c: Parameters<Parameters<typeof downloadRoutes.post>[1]>[0],
  job: ReturnType<typeof getJob> & {}
) {
  const retryableFiles = getRetryableJobFiles(job.id);

  if (retryableFiles.length === 0) {
    return c.json({
      job_id: job.id,
      status: job.status,
      message: "No retryable files found",
    });
  }

  // Use job's persistent release identity to search again
  const artist = job.artist ?? "";
  const title = job.release_title ?? "";

  if (!artist && !title) {
    throw new AppError(
      "SEARCH_FAILED",
      "Job lacks sufficient identity for alternate peer search",
      400
    );
  }

  // Search for alternate source
  const query = `${artist} ${title}`;
  const search = await slskd.startSearch(query);
  const responses = await slskd.waitForSearchCompletion(search.id, 7000);

  // Find a different peer with compatible files
  const originalPeer = job.peer;
  const altResponses = responses.filter((r) => r.username !== originalPeer);

  if (altResponses.length === 0) {
    return c.json({
      job_id: job.id,
      status: job.status,
      message: "No alternate peers found",
    });
  }

  // Try to match failed logical files in alternate responses
  const { groupByDirectory, computeStats } = await import("../domain/candidates");
  const altCandidates = groupByDirectory(altResponses);
  const bestAlt = altCandidates
    .filter((c) => c.files.filter((f) => f.kind === "audio").length > 0)
    .sort(
      (a, b) =>
        b.files.filter((f) => f.kind === "audio").length -
        a.files.filter((f) => f.kind === "audio").length
    )[0];

  if (!bestAlt) {
    return c.json({
      job_id: job.id,
      status: job.status,
      message: "No suitable alternate candidate found",
    });
  }

  // Enqueue matching files from alternate peer
  const filesToEnqueue = retryableFiles
    .map((failed) => {
      const match = bestAlt.files.find(
        (f) =>
          f.kind === failed.kind &&
          getFilename(f.filename).toLowerCase().includes(
            failed.logical_filename.replace(/\.[^.]+$/, "").toLowerCase()
          )
      );
      return match ? { filename: match.filename, size: match.size } : null;
    })
    .filter((f): f is { filename: string; size: number } => f !== null);

  if (filesToEnqueue.length === 0) {
    return c.json({
      job_id: job.id,
      status: job.status,
      message: "Could not match failed files to alternate peer",
    });
  }

  await slskd.enqueueFiles(bestAlt.peer, filesToEnqueue);

  for (const file of retryableFiles) {
    updateJobFileStatus(file.id, "queued");
  }

  updateJobStatus(job.id, "retrying");
  incrementJobAttempt(job.id);

  log("info", "download_retry_alternate", {
    job_id: job.id,
    original_peer: originalPeer,
    alternate_peer: bestAlt.peer,
    files_retried: filesToEnqueue.length,
  });

  return c.json({
    job_id: job.id,
    status: "retrying",
    retry: {
      strategy: "alternate_peer",
      failed_files: filesToEnqueue.length,
    },
  });
}
