import { log } from "../middleware/logging";
import * as slskd from "./slskd";
import * as navidrome from "./navidrome";
import { matchLibraryAlbums } from "../domain/matching";
import {
  getCandidate,
  getCandidatesBySearch,
  isCandidateExpired,
  type CandidateRecord,
} from "../db/repositories/candidates";
import {
  createJob,
  getJob,
  updateJobStatus,
  type JobRecord,
} from "../db/repositories/jobs";
import {
  createJobFiles,
  failAllJobFiles,
  getJobFiles,
} from "../db/repositories/job-files";
import {
  createAcquisition,
  findActiveAcquisition,
  finishAttempt,
  getAcquisition,
  getAcquisitionByJobId,
  listActiveAcquisitions,
  parseAttemptedCandidates,
  parseBlockedPeers,
  blockPeer,
  setCurrentAttempt,
  updateAcquisitionStatus,
  type AcquisitionRecord,
} from "../db/repositories/acquisitions";
import { selectDownloadFiles, type CandidateFile } from "../domain/candidates";
import {
  hasSameSourceRetryBudget,
  isSystemicSourceFailure,
  selectNextAcquisitionCandidate,
} from "../domain/acquisition-policy";

const MAX_FILE_RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_SOURCE_ATTEMPTS = 5;
const LIBRARY_VERIFICATION_TIMEOUT_MS = 15 * 60 * 1000;

export async function startAcquisition(params: {
  artist: string;
  title: string;
  releaseType: string;
  searchId: string;
  candidateId: string;
  maxSourceAttempts?: number;
}) {
  const existing = findActiveAcquisition({
    artist: params.artist,
    title: params.title,
    releaseType: params.releaseType,
  });
  if (existing) {
    return acquisitionSnapshot(existing);
  }

  const candidate = getCandidate(params.candidateId);
  if (!candidate) throw new Error("Candidate not found");
  if (candidate.search_id !== params.searchId) {
    throw new Error("Candidate does not belong to the supplied search");
  }

  const acquisition = createAcquisition({
    artist: params.artist,
    title: params.title,
    releaseType: params.releaseType,
    searchId: params.searchId,
    maxSourceAttempts: Math.min(
      Math.max(params.maxSourceAttempts ?? DEFAULT_MAX_SOURCE_ATTEMPTS, 1),
      10
    ),
  });

  await enqueueCandidateForAcquisition(acquisition, candidate);
  return acquisitionSnapshot(getAcquisition(acquisition.id)!);
}

export function getAcquisitionSnapshot(id: string) {
  const acquisition = getAcquisition(id);
  return acquisition ? acquisitionSnapshot(acquisition) : null;
}

/**
 * Tell the generic same-source retrier whether this job is still the active
 * attempt of an acquisition and worth retrying. Old attempts and systemic
 * source failures must not keep consuming retry cycles after failover.
 */
export function shouldAutoRetryAcquisitionJob(jobId: string): boolean {
  const acquisition = getAcquisitionByJobId(jobId);
  if (!acquisition) return true;
  if (acquisition.status === "completed" || acquisition.status === "failed") return false;
  if (acquisition.current_job_id !== jobId) return false;

  const files = getJobFiles(jobId);
  return !isSystemicSourceFailure(files);
}

export async function advanceActiveAcquisitions(): Promise<number> {
  let changed = 0;
  for (const acquisition of listActiveAcquisitions(100)) {
    try {
      const before = `${acquisition.status}:${acquisition.current_job_id}:${acquisition.source_attempts}`;
      await advanceAcquisition(acquisition.id);
      const afterRecord = getAcquisition(acquisition.id);
      const after = afterRecord
        ? `${afterRecord.status}:${afterRecord.current_job_id}:${afterRecord.source_attempts}`
        : "missing";
      if (after !== before) changed++;
    } catch (err) {
      log("warn", "acquisition_advance_failed", {
        acquisition_id: acquisition.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return changed;
}

async function advanceAcquisition(acquisitionId: string): Promise<void> {
  let acquisition = getAcquisition(acquisitionId);
  if (!acquisition || acquisition.status === "completed" || acquisition.status === "failed") {
    return;
  }

  if (!acquisition.current_job_id) {
    updateAcquisitionStatus(acquisition.id, "failed", { error: "acquisition_has_no_download_job" });
    return;
  }

  const job = getJob(acquisition.current_job_id);
  if (!job) {
    updateAcquisitionStatus(acquisition.id, "failed", { error: "current_download_job_missing" });
    return;
  }

  if (job.status === "completed") {
    finishAttempt(job.id, "completed", null);
    await verifyCompletedAcquisition(acquisition, job);
    return;
  }

  if (["queued", "downloading", "retrying"].includes(job.status)) return;

  if (job.status !== "failed" && job.status !== "partial_failure" && job.status !== "cancelled") {
    return;
  }

  const files = getJobFiles(job.id);
  const systemic = isSystemicSourceFailure(files);

  // The generic reconciler runs same-source retries before this controller.
  // If retry budget remains, leave this attempt alone unless the whole source
  // is clearly dead (e.g. every file timed out at zero progress).
  if (!systemic && hasSameSourceRetryBudget(files, MAX_FILE_RETRY_ATTEMPTS)) {
    return;
  }

  finishAttempt(job.id, job.status, job.last_error);
  if (job.peer) blockPeer(acquisition.id, job.peer);

  acquisition = getAcquisition(acquisition.id)!;
  if (acquisition.source_attempts >= acquisition.max_source_attempts) {
    updateAcquisitionStatus(acquisition.id, "failed", {
      error: `source_attempt_limit_reached:${acquisition.source_attempts}`,
    });
    log("warn", "acquisition_exhausted", {
      acquisition_id: acquisition.id,
      source_attempts: acquisition.source_attempts,
      reason: "source_attempt_limit",
    });
    return;
  }

  const next = selectNextAcquisitionCandidate(
    getCandidatesBySearch(acquisition.search_id),
    parseAttemptedCandidates(acquisition),
    parseBlockedPeers(acquisition)
  );

  if (!next) {
    updateAcquisitionStatus(acquisition.id, "failed", {
      error: "candidate_pool_exhausted",
    });
    log("warn", "acquisition_exhausted", {
      acquisition_id: acquisition.id,
      source_attempts: acquisition.source_attempts,
      reason: "candidate_pool_exhausted",
    });
    return;
  }

  await enqueueCandidateForAcquisition(acquisition, next);
}

async function enqueueCandidateForAcquisition(
  acquisition: AcquisitionRecord,
  candidate: CandidateRecord
): Promise<JobRecord> {
  if (isCandidateExpired(candidate)) {
    throw new Error(`Candidate expired: ${candidate.id}`);
  }

  const storedFiles: CandidateFile[] = candidate.files_json
    ? JSON.parse(candidate.files_json)
    : [];
  const filesToDownload = selectDownloadFiles(storedFiles);
  if (filesToDownload.length === 0) {
    throw new Error(`Candidate has no downloadable audio files: ${candidate.id}`);
  }

  const job = createJob({
    candidateId: candidate.id,
    artist: acquisition.artist,
    releaseTitle: acquisition.title,
    releaseType: acquisition.release_type,
    selectedFormat: candidate.format ?? undefined,
    peer: candidate.peer,
    remoteDirectory: candidate.remote_directory,
    originalQuery: {
      acquisition_id: acquisition.id,
      search_id: acquisition.search_id,
      peer: candidate.peer,
      directory: candidate.remote_directory,
    },
  });

  createJobFiles(filesToDownload.map((file) => ({
    jobId: job.id,
    logicalFilename: file.filename.replace(/^.*[\\/]/, ""),
    remoteFilename: file.filename,
    size: file.size,
    kind: file.kind,
    peer: candidate.peer,
  })));

  setCurrentAttempt({
    acquisitionId: acquisition.id,
    candidateId: candidate.id,
    jobId: job.id,
    peer: candidate.peer,
  });

  try {
    await slskd.enqueueFiles(
      candidate.peer,
      filesToDownload.map((file) => ({ filename: file.filename, size: file.size }))
    );
    updateJobStatus(job.id, "downloading", null);
    log("info", "acquisition_source_enqueued", {
      acquisition_id: acquisition.id,
      job_id: job.id,
      candidate_id: candidate.id,
      peer: candidate.peer,
      files: filesToDownload.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failAllJobFiles(job.id, message);
    updateJobStatus(job.id, "failed", message);
    finishAttempt(job.id, "failed", message);
    log("warn", "acquisition_source_enqueue_failed", {
      acquisition_id: acquisition.id,
      job_id: job.id,
      candidate_id: candidate.id,
      peer: candidate.peer,
      error: message,
    });
  }

  return getJob(job.id)!;
}

async function verifyCompletedAcquisition(
  acquisition: AcquisitionRecord,
  job: JobRecord
): Promise<void> {
  // Track acquisitions already use matched-only transfer semantics. For them,
  // successful transfer completion is sufficient; album ownership matching is
  // intentionally release-oriented.
  if (acquisition.release_type === "track") {
    updateAcquisitionStatus(acquisition.id, "completed");
    return;
  }

  const query = `${acquisition.artist} ${acquisition.title}`;
  const results = await navidrome.search3(query, { albumCount: 20, songCount: 0 });
  const ownership = matchLibraryAlbums(acquisition.artist, acquisition.title, results.albums);

  if (ownership.owned && ownership.confidence >= 0.9) {
    updateAcquisitionStatus(acquisition.id, "completed");
    log("info", "acquisition_completed", {
      acquisition_id: acquisition.id,
      job_id: job.id,
      source_attempts: acquisition.source_attempts,
      verification: "navidrome",
    });
    return;
  }

  const verificationStarted = acquisition.verification_started_at
    ? new Date(acquisition.verification_started_at).getTime()
    : Date.now();

  if (!acquisition.verification_started_at) {
    updateAcquisitionStatus(acquisition.id, "verifying", {
      verificationStartedAt: new Date(verificationStarted).toISOString(),
    });
    return;
  }

  if (Date.now() - verificationStarted > LIBRARY_VERIFICATION_TIMEOUT_MS) {
    updateAcquisitionStatus(acquisition.id, "failed", {
      error: "library_verification_timeout",
    });
    log("warn", "acquisition_verification_timeout", {
      acquisition_id: acquisition.id,
      job_id: job.id,
    });
  }
}

function acquisitionSnapshot(acquisition: AcquisitionRecord) {
  const job = acquisition.current_job_id ? getJob(acquisition.current_job_id) : null;
  return {
    acquisition_id: acquisition.id,
    status: acquisition.status,
    artist: acquisition.artist,
    title: acquisition.title,
    release_type: acquisition.release_type,
    search_id: acquisition.search_id,
    job_id: acquisition.current_job_id,
    source_attempts: acquisition.source_attempts,
    max_source_attempts: acquisition.max_source_attempts,
    attempted_candidate_ids: parseAttemptedCandidates(acquisition),
    blocked_peers: parseBlockedPeers(acquisition),
    error: acquisition.last_error ?? undefined,
    job: job
      ? {
          job_id: job.id,
          status: job.status,
          candidate_id: job.candidate_id,
          peer: job.peer,
          release: job.release_title,
        }
      : null,
  };
}
