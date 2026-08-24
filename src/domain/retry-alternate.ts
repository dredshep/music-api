import { groupByDirectory, getFilename } from "./candidates";
import type { SlskdSearchResponse } from "../types/upstream";

export interface RetryableFileRef {
  logical_filename: string;
  kind: string;
}

export type AlternateRetryPlan =
  | {
      ok: true;
      alternatePeer: string;
      filesToEnqueue: Array<{ filename: string; size: number }>;
    }
  | {
      ok: false;
      reason: "no_alternate_peers" | "no_suitable_candidate" | "no_file_matches";
      message: string;
    };

export function planAlternatePeerRetry(params: {
  originalPeer: string | null;
  retryableFiles: RetryableFileRef[];
  responses: SlskdSearchResponse[];
}): AlternateRetryPlan {
  const altResponses = params.responses.filter(
    (r) => r.username !== params.originalPeer
  );

  if (altResponses.length === 0) {
    return {
      ok: false,
      reason: "no_alternate_peers",
      message: "No alternate peers found",
    };
  }

  const altCandidates = groupByDirectory(altResponses);
  const bestAlt = altCandidates
    .filter((c) => c.files.filter((f) => f.kind === "audio").length > 0)
    .sort(
      (a, b) =>
        b.files.filter((f) => f.kind === "audio").length -
        a.files.filter((f) => f.kind === "audio").length
    )[0];

  if (!bestAlt) {
    return {
      ok: false,
      reason: "no_suitable_candidate",
      message: "No suitable alternate candidate found",
    };
  }

  const filesToEnqueue = params.retryableFiles
    .map((failed) => {
      const match = bestAlt.files.find(
        (f) =>
          f.kind === failed.kind &&
          getFilename(f.filename)
            .toLowerCase()
            .includes(failed.logical_filename.replace(/\.[^.]+$/, "").toLowerCase())
      );
      return match ? { filename: match.filename, size: match.size } : null;
    })
    .filter((f): f is { filename: string; size: number } => f !== null);

  if (filesToEnqueue.length === 0) {
    return {
      ok: false,
      reason: "no_file_matches",
      message: "Could not match failed files to alternate peer",
    };
  }

  return {
    ok: true,
    alternatePeer: bestAlt.peer,
    filesToEnqueue,
  };
}
