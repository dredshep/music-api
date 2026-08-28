/**
 * Shared budget for an entire Gradient route/leg search. Tracks ALL work
 * across online discovery, cached graph search, artist-bridge calls,
 * bridge-track lookups, chained recording searches, and densification.
 */
export interface GradientRouteBudget {
  readonly maxQueries: number;
  readonly deadlineMs: number;
  readonly startedAt: number;

  recordingNeighborExpansions: number;
  artistBridgeCalls: number;
  bridgeTrackLookups: number;
  chainedRecordingQueries: number;
  densificationQueries: number;
  compressionQueries: number;
  cachedGraphNodesExpanded: number;
  cachedGraphEdgesExpanded: number;
  initialRecordingQueries: number;
}

export interface GradientRouteBudgetSnapshot {
  maxQueries: number;
  totalUsed: number;
  remaining: number;
  deadlineMs: number;
  elapsedMs: number;
  deadlineExhausted: boolean;
  budgetExhausted: boolean;
  recordingNeighborExpansions: number;
  artistBridgeCalls: number;
  bridgeTrackLookups: number;
  chainedRecordingQueries: number;
  densificationQueries: number;
  compressionQueries: number;
  cachedGraphNodesExpanded: number;
  cachedGraphEdgesExpanded: number;
  initialRecordingQueries: number;
}

export function createRouteBudget(maxQueries: number, deadlineMs: number): GradientRouteBudget {
  return {
    maxQueries,
    deadlineMs,
    startedAt: performance.now(),
    recordingNeighborExpansions: 0,
    artistBridgeCalls: 0,
    bridgeTrackLookups: 0,
    chainedRecordingQueries: 0,
    densificationQueries: 0,
    compressionQueries: 0,
    cachedGraphNodesExpanded: 0,
    cachedGraphEdgesExpanded: 0,
    initialRecordingQueries: 0,
  };
}

export function budgetTotalUsed(budget: GradientRouteBudget): number {
  return budget.initialRecordingQueries
    + budget.chainedRecordingQueries
    + budget.densificationQueries
    + budget.compressionQueries
    + budget.artistBridgeCalls
    + budget.bridgeTrackLookups;
}

export function budgetRemaining(budget: GradientRouteBudget): number {
  return Math.max(0, budget.maxQueries - budgetTotalUsed(budget));
}

export function budgetElapsedMs(budget: GradientRouteBudget): number {
  return performance.now() - budget.startedAt;
}

export function isBudgetExhausted(budget: GradientRouteBudget): boolean {
  return budgetTotalUsed(budget) >= budget.maxQueries
    || budgetElapsedMs(budget) >= budget.deadlineMs;
}

export function snapshotBudget(budget: GradientRouteBudget): GradientRouteBudgetSnapshot {
  const totalUsed = budgetTotalUsed(budget);
  const elapsedMs = budgetElapsedMs(budget);
  return {
    maxQueries: budget.maxQueries,
    totalUsed,
    remaining: Math.max(0, budget.maxQueries - totalUsed),
    deadlineMs: budget.deadlineMs,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    deadlineExhausted: elapsedMs >= budget.deadlineMs,
    budgetExhausted: totalUsed >= budget.maxQueries,
    recordingNeighborExpansions: budget.recordingNeighborExpansions,
    artistBridgeCalls: budget.artistBridgeCalls,
    bridgeTrackLookups: budget.bridgeTrackLookups,
    chainedRecordingQueries: budget.chainedRecordingQueries,
    densificationQueries: budget.densificationQueries,
    compressionQueries: budget.compressionQueries,
    cachedGraphNodesExpanded: budget.cachedGraphNodesExpanded,
    cachedGraphEdgesExpanded: budget.cachedGraphEdgesExpanded,
    initialRecordingQueries: budget.initialRecordingQueries,
  };
}
