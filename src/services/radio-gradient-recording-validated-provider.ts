import type {
  GradientRecordingNeighbor,
  GradientRecordingNeighborProvider,
} from "./radio-gradient-recording-path";
import {
  createCachedGradientRecordingProvider,
  type GradientRecordingProviderDiagnostics,
} from "./radio-gradient-recording-provider";
import { assessCachedAcousticTransition } from "./radio-transition-quality";

export interface GradientValidatedProviderDiagnostics extends GradientRecordingProviderDiagnostics {
  acousticAssessments: number;
  acousticEvidenceEdges: number;
  acousticPenaltyEdges: number;
  acousticValidationMs: number;
  catastrophicRejectedEdges: number;
  catastrophicReasons: Record<string, number>;
}

export interface ValidatedGradientRecordingProvider extends GradientRecordingNeighborProvider {
  diagnostics(): GradientValidatedProviderDiagnostics;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Collaborative similarity discovers global territory. Cached local DSP then
 * acts as independent evidence: catastrophic known cliffs are rejected; weaker
 * but non-catastrophic local matches reduce confidence; missing analysis stays
 * neutral and never becomes a compatibility bonus.
 */
export function createValidatedGradientRecordingProvider(): ValidatedGradientRecordingProvider {
  const base = createCachedGradientRecordingProvider();
  let acousticAssessments = 0;
  let acousticEvidenceEdges = 0;
  let acousticPenaltyEdges = 0;
  let acousticValidationMs = 0;
  let catastrophicRejectedEdges = 0;
  const catastrophicReasons: Record<string, number> = {};

  return {
    async neighbors(source, limit) {
      const rows = await base.neighbors(source, Math.max(limit * 2, limit));
      const accepted: GradientRecordingNeighbor[] = [];
      for (const row of rows) {
        acousticAssessments++;
        let assessment;
        const startedAt = performance.now();
        try {
          assessment = assessCachedAcousticTransition(source, row);
        } catch {
          assessment = null;
        } finally {
          acousticValidationMs += performance.now() - startedAt;
        }
        if (assessment?.evidenceCount) acousticEvidenceEdges++;
        if (assessment?.catastrophic) {
          catastrophicRejectedEdges++;
          for (const reason of assessment.reasons) catastrophicReasons[reason] = (catastrophicReasons[reason] ?? 0) + 1;
          continue;
        }

        let confidence = row.confidence ?? 0.75;
        if (assessment && assessment.evidenceCount >= 3 && assessment.score != null) {
          if (assessment.score < 0.35) {
            confidence *= clamp(assessment.score / 0.35, 0.35, 1);
            acousticPenaltyEdges++;
          } else if (assessment.score >= 0.72) {
            confidence = clamp(confidence + 0.06, 0.05, 1);
          }
        }
        accepted.push({ ...row, confidence });
        if (accepted.length >= limit) break;
      }
      return accepted;
    },
    diagnostics() {
      return {
        ...base.diagnostics(),
        acousticAssessments,
        acousticEvidenceEdges,
        acousticPenaltyEdges,
        acousticValidationMs: Number(acousticValidationMs.toFixed(2)),
        catastrophicRejectedEdges,
        catastrophicReasons: { ...catastrophicReasons },
      };
    },
  };
}
