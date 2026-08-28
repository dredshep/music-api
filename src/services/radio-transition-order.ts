import type { RadioTrackRow } from "../db/repositories/radio";
import { assessCachedAcousticTransition } from "./radio-transition-quality";

export interface CachedTransitionOrderScore {
  score: number | null;
  evidenceEdges: number;
  catastrophicEdges: number;
  unknownEdges: number;
}

/** Independent cached-acoustic score for diagnostics; route coordinates are not input. */
export function scoreCachedTransitionOrder(tracks: RadioTrackRow[]): CachedTransitionOrderScore {
  let total = 0;
  let evidenceEdges = 0;
  let catastrophicEdges = 0;
  let unknownEdges = 0;
  for (let index = 1; index < tracks.length; index++) {
    const assessment = assessCachedAcousticTransition(tracks[index - 1]!, tracks[index]!);
    if (assessment.score == null || assessment.evidenceCount === 0) {
      unknownEdges++;
      continue;
    }
    evidenceEdges++;
    if (assessment.catastrophic) catastrophicEdges++;
    // A catastrophic edge is diagnostically a zero even if a few dimensions
    // happen to average above zero; otherwise use the independent acoustic mean.
    total += assessment.catastrophic ? 0 : assessment.score;
  }
  return {
    score: evidenceEdges ? total / evidenceEdges : null,
    evidenceEdges,
    catastrophicEdges,
    unknownEdges,
  };
}
