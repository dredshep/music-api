export interface AcquisitionPolicyFile {
  status: string;
  attempts: number;
  last_error: string | null;
}

export interface AcquisitionPolicyCandidate {
  id: string;
  peer: string;
  score: number | null;
  expires_at: string;
  files_json: string | null;
}

const AUTO_RETRYABLE_ERRORS = new Set([
  "timeout",
  "transfer_error",
  "transfer_aborted",
  "missing_transfer",
]);

export function isAutoRetryableAcquisitionError(error: string | null): boolean {
  return error != null && AUTO_RETRYABLE_ERRORS.has(error);
}

/**
 * A source-level failure is one where essentially nothing useful came from the
 * peer. Retrying twelve zero-byte timeouts against the same peer is wasted
 * work; move to another candidate instead.
 */
export function isSystemicSourceFailure(files: AcquisitionPolicyFile[]): boolean {
  if (files.length < 3) return false;

  const completed = files.filter((f) => f.status === "completed").length;
  if (completed > 0) return false;

  const failed = files.filter(
    (f) => f.status === "failed" || f.status === "cancelled"
  );
  if (failed.length / files.length < 0.8) return false;

  return failed.every((f) => isAutoRetryableAcquisitionError(f.last_error));
}

export function hasSameSourceRetryBudget(
  files: AcquisitionPolicyFile[],
  maxAttempts: number
): boolean {
  return files.some(
    (f) =>
      (f.status === "failed" || f.status === "cancelled") &&
      f.attempts < maxAttempts &&
      isAutoRetryableAcquisitionError(f.last_error)
  );
}

/** Select the best fresh candidate that this acquisition has not already tried. */
export function selectNextAcquisitionCandidate<T extends AcquisitionPolicyCandidate>(
  candidates: T[],
  attemptedCandidateIds: Iterable<string>,
  blockedPeers: Iterable<string>,
  now = new Date()
): T | null {
  const attempted = new Set(attemptedCandidateIds);
  const blocked = new Set([...blockedPeers].map((peer) => peer.toLowerCase()));

  return (
    candidates
      .filter((candidate) => !attempted.has(candidate.id))
      .filter((candidate) => !blocked.has(candidate.peer.toLowerCase()))
      .filter((candidate) => candidate.files_json != null)
      .filter((candidate) => new Date(candidate.expires_at).getTime() > now.getTime())
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null
  );
}
