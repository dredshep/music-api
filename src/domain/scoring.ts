import type { CandidateFlagName } from "../types/api";
import type { CandidateStats } from "./candidates";

export interface ScoringInput {
  stats: CandidateStats;
  flags: CandidateFlagName[];
  freeUploadSlots: boolean;
  uploadSpeed: number;
  queueLength: number;
  expectedTrackCount?: number;
  preferredFormats?: string[];
  preferLrc?: boolean;
  releaseType?: string;
}

export interface ScoringResult {
  score: number;
  reason: string;
}

export function scoreCandidate(input: ScoringInput): ScoringResult {
  let score = 0;
  const reasons: string[] = [];

  // Format scoring (+30 max)
  score += scoreFormat(input.stats.dominantFormat, input.flags);
  if (input.flags.includes("lossless")) {
    reasons.push("lossless");
  } else if (input.flags.includes("lossy")) {
    reasons.push("lossy");
  }

  // Completeness scoring (+25 max)
  const completenessScore = scoreCompleteness(
    input.stats.audioFileCount,
    input.expectedTrackCount,
    input.releaseType
  );
  score += completenessScore.points;
  if (completenessScore.points > 15) {
    reasons.push("complete release");
  } else if (completenessScore.points < 0) {
    reasons.push("possibly incomplete");
  }

  // LRC scoring (+20 max)
  const lrcScore = scoreLrc(input.stats.lrcCoverage, input.preferLrc);
  score += lrcScore;
  if (lrcScore >= 15) {
    reasons.push("matching synced lyrics");
  }

  // Peer scoring (+20 max)
  score += scorePeer(input.freeUploadSlots, input.uploadSpeed, input.queueLength);
  if (input.freeUploadSlots && input.uploadSpeed > 1000000) {
    reasons.push("available fast peer");
  }

  // Negative flags
  score += scoreNegativeFlags(input.flags);
  if (input.flags.includes("live")) reasons.push("live recording");
  if (input.flags.includes("bootleg")) reasons.push("bootleg");
  if (input.flags.includes("karaoke")) reasons.push("karaoke");

  // Clamp 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));

  const reason = reasons.length > 0
    ? buildReason(score, input.stats, reasons)
    : `Score: ${score}`;

  return { score, reason };
}

function scoreFormat(dominant: string, flags: CandidateFlagName[]): number {
  const fmt = dominant.toUpperCase();

  let base = 0;
  if (fmt === "FLAC") base = 30;
  else if (fmt === "ALAC") base = 27;
  else if (fmt === "APE") base = 24;
  else if (fmt === "WAV") base = 22;
  else if (fmt === "MP3") base = 15;
  else if (fmt === "OGG" || fmt === "OPUS") base = 12;
  else if (fmt === "M4A" || fmt === "AAC") base = 12;
  else base = 8;

  if (flags.includes("mixed_formats")) base -= 8;

  return base;
}

function scoreCompleteness(
  foundTracks: number,
  expectedTracks?: number,
  releaseType?: string
): { points: number; status: string } {
  // Singles and tracks: 1+ audio files is valid — never penalise for low count
  if (releaseType === "single" || releaseType === "track") {
    if (expectedTracks && expectedTracks > 0) {
      const ratio = foundTracks / expectedTracks;
      if (ratio >= 1.0) return { points: 25, status: "complete" };
      if (ratio >= 0.5) return { points: 15, status: "likely_complete" };
    }
    if (foundTracks >= 1) return { points: 20, status: "likely_complete" };
    return { points: 0, status: "uncertain" };
  }

  if (!expectedTracks || expectedTracks === 0) {
    if (foundTracks >= 8) return { points: 20, status: "likely_complete" };
    if (foundTracks >= 4) return { points: 10, status: "uncertain" };
    return { points: -10, status: "likely_incomplete" };
  }

  const ratio = foundTracks / expectedTracks;

  if (ratio >= 1.0) return { points: 25, status: "complete" };
  if (ratio >= 0.9) return { points: 20, status: "likely_complete" };
  if (ratio >= 0.7) return { points: 5, status: "uncertain" };
  if (ratio >= 0.5) return { points: -15, status: "likely_incomplete" };
  return { points: -35, status: "incomplete" };
}

function scoreLrc(coverage: number, preferLrc?: boolean): number {
  if (!preferLrc && coverage === 0) return 0;

  if (coverage >= 1.0) return 20;
  if (coverage >= 0.8) return 15;
  if (coverage > 0) return 5;
  return 0;
}

function scorePeer(
  freeSlots: boolean,
  speed: number,
  queueLength: number
): number {
  let points = 0;

  if (freeSlots) points += 10;

  // Speed scoring (bytes/sec): 0-10 points
  if (speed > 5000000) points += 10;        // >5 MB/s
  else if (speed > 1000000) points += 7;    // >1 MB/s
  else if (speed > 500000) points += 4;     // >500 KB/s
  else if (speed > 100000) points += 1;     // >100 KB/s
  else if (speed > 0) points -= 5;          // very slow

  if (queueLength > 100) points -= 10;
  else if (queueLength > 50) points -= 5;

  return points;
}

function scoreNegativeFlags(flags: CandidateFlagName[]): number {
  let penalty = 0;

  if (flags.includes("live")) penalty -= 40;
  if (flags.includes("bootleg")) penalty -= 35;
  if (flags.includes("karaoke")) penalty -= 50;
  if (flags.includes("possible_wrong_release")) penalty -= 60;
  if (flags.includes("likely_incomplete")) penalty -= 20;

  return penalty;
}

function buildReason(
  score: number,
  stats: CandidateStats,
  reasonParts: string[]
): string {
  const format = stats.dominantFormat;
  const tracks = stats.audioFileCount;

  let summary = "";
  if (score >= 80) {
    summary = `${format} release (${tracks} tracks)`;
  } else if (score >= 50) {
    summary = `${format} release (${tracks} tracks)`;
  } else {
    summary = `${format} (${tracks} tracks)`;
  }

  const details = reasonParts.filter(Boolean).join(", ");
  return details ? `${summary} with ${details}.` : `${summary}.`;
}

export function getCompletenessStatus(
  foundTracks: number,
  expectedTracks?: number,
  releaseType?: string
): {
  status: string;
  confidence: number;
  expectedTracks?: number;
  foundTracks: number;
} {
  if (releaseType === "single" || releaseType === "track") {
    if (expectedTracks && expectedTracks > 0) {
      const ratio = foundTracks / expectedTracks;
      if (ratio >= 1.0) return { status: "complete", confidence: 0.95, expectedTracks, foundTracks };
      if (ratio >= 0.5) return { status: "likely_complete", confidence: 0.8, expectedTracks, foundTracks };
    }
    if (foundTracks >= 1) return { status: "likely_complete", confidence: 0.85, foundTracks };
    return { status: "uncertain", confidence: 0.5, foundTracks };
  }

  if (!expectedTracks) {
    return {
      status: foundTracks >= 6 ? "likely_complete" : "uncertain",
      confidence: 0.5,
      foundTracks,
    };
  }

  const ratio = foundTracks / expectedTracks;

  if (ratio >= 1.0) {
    return { status: "complete", confidence: 0.95, expectedTracks, foundTracks };
  }
  if (ratio >= 0.9) {
    return { status: "likely_complete", confidence: 0.85, expectedTracks, foundTracks };
  }
  if (ratio >= 0.7) {
    return { status: "uncertain", confidence: 0.5, expectedTracks, foundTracks };
  }
  if (ratio >= 0.5) {
    return { status: "likely_incomplete", confidence: 0.7, expectedTracks, foundTracks };
  }
  return { status: "incomplete", confidence: 0.9, expectedTracks, foundTracks };
}
