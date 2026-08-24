export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
    retry_after_ms?: number;
  };
}

export type ReleaseType = "album" | "ep" | "single" | "track" | "any";

export type FileKind = "audio" | "lyrics" | "image" | "cue" | "log" | "sidecar" | "other";

export type JobStatus =
  | "queued"
  | "downloading"
  | "completed"
  | "partial_failure"
  | "failed"
  | "cancelled"
  | "retrying";

export type FileStatus =
  | "queued"
  | "waiting_remote"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export type CompletenessStatus =
  | "complete"
  | "likely_complete"
  | "uncertain"
  | "likely_incomplete"
  | "incomplete";

export interface CandidateFlag {
  name: string;
}

export const CANDIDATE_FLAGS = [
  "lossless",
  "lossy",
  "mixed_formats",
  "complete_lrc",
  "partial_lrc",
  "live",
  "bootleg",
  "remix",
  "instrumental",
  "karaoke",
  "vinyl_rip",
  "web",
  "deluxe",
  "expanded",
  "anniversary",
  "remaster",
  "multi_disc",
  "likely_incomplete",
  "possible_wrong_release",
  "no_free_slot",
  "slow_peer",
  "long_queue",
] as const;

export type CandidateFlagName = (typeof CANDIDATE_FLAGS)[number];
