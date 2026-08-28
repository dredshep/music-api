import { normalizeForComparison } from "../domain/normalization";
import { budgetRemaining, isBudgetExhausted, type GradientRouteBudget } from "./radio-gradient-budget";
import { densifyGradientRecordingPathWithSubpathFallback } from "./radio-gradient-densify-subpath";
import {
  gradientRecordingEdgeCost,
  positionGradientRecordingPath,
  type GradientRecording,
  type GradientRecordingNeighbor,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
  type PositionedGradientRecording,
} from "./radio-gradient-recording-path";

export interface GradientSpacingRepairOperation {
  gapIndex: number;
  gapShareBefore: number;
  maxEdgeShareAfter: number;
  inserted: Array<{ artist: string; title: string }>;
  removed: Array<{ artist: string; title: string }>;
}

export interface GradientSpacingRepairResult {
  path: GradientRecordingPath;
  positioned: PositionedGradientRecording[];
  operations: GradientSpacingRepairOperation[];
  queryCount: number;
  maxEdgeShareBefore: number;
  maxEdgeShareAfter: number;
  threshold: number;
  stoppedReason: "balanced" | "not_applicable" | "no_bridge" | "no_safe_resample" | "query_budget" | "repair_limit";
}

export interface GradientSpacingRepairOptions {
  budget: GradientRouteBudget;
  endpointArtists?: [string, string] | null;
  mandatoryKeys?: Set<string>;
  scenic?: boolean;
  maxRepairs?: number;
  maxEdgeShare?: number;
}

function edgeCost(edge: GradientRecordingPathEdge) {
  return gradientRecordingEdgeCost(edge.similarity, edge.confidence);
}

export function gradientMaxEdgeShare(path: GradientRecordingPath) {
  if (!path.edges.length) return 0;
  const costs = path.edges.map(edgeCost);
  const total = Math.max(0.000001, costs.reduce((sum, value) => sum + value, 0));
  return Math.max(...costs.map((value) => value / total));
}

function worstGap(path: GradientRecordingPath) {
  if (!path.edges.length) return null;
  const costs = path.edges.map(edgeCost);
  const total = Math.max(0.000001, costs.reduce((sum, value) => sum + value, 0));
  let index = 0;
  for (let i = 1; i < costs.length; i++) {
    if (costs[i]! > costs[index]!) index = i;
  }
  return { index, share: costs[index]! / total };
}

function withPathCost(path: GradientRecordingPath): GradientRecordingPath {
  return {
    ...path,
    cost: path.edges.reduce((sum, edge) => sum + edgeCost(edge), 0),
  };
}

function gapPath(path: GradientRecordingPath, gapIndex: number): GradientRecordingPath {
  const left = path.recordings[gapIndex]!;
  const right = path.recordings[gapIndex + 1]!;
  const edge = path.edges[gapIndex]!;
  return {
    recordings: [left, right],
    edges: [edge],
    cost: edgeCost(edge),
    queryCount: 0,
    nodesVisited: 2,
    forwardFrontierSize: 0,
    backwardFrontierSize: 0,
    intersection: null,
  };
}

async function expandWorstGap(
  path: GradientRecordingPath,
  gapIndex: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientSpacingRepairOptions,
) {
  let queries = 0;
  const run = async (targetLength: number, allowance: number) => {
    if (allowance <= 0 || isBudgetExhausted(options.budget)) return null;
    const result = await densifyGradientRecordingPathWithSubpathFallback(
      gapPath(path, gapIndex),
      targetLength,
      provider,
      {
        maxQueries: allowance,
        neighborLimit: options.scenic ? 56 : 48,
        minBridgeSimilarity: options.scenic ? 0.09 : 0.12,
        endpointArtists: options.endpointArtists,
        // Spacing repair is about transition continuity. Do not let the local
        // two-node subpath's artificial 50% coordinate distort familiarity.
        familiarityWeight: 0,
      },
    );
    queries += result.queryCount;
    options.budget.densificationQueries += result.queryCount;
    return result;
  };

  const singleAllowance = Math.min(options.scenic ? 32 : 24, budgetRemaining(options.budget));
  const single = await run(3, singleAllowance);
  if (single && single.path.recordings.length > 2) return { dense: single, queries };

  const doubleAllowance = Math.min(options.scenic ? 48 : 36, budgetRemaining(options.budget));
  const double = await run(4, doubleAllowance);
  if (double && double.path.recordings.length > 2) return { dense: double, queries };
  return { dense: null, queries };
}

type BalancedCompression = {
  path: GradientRecordingPath;
  removed: Array<{ artist: string; title: string }>;
  queries: number;
};

/**
 * Restore the requested track count after inserting a bridge. Every removal is
 * backed by a real validated skip edge. Among safe removals, prefer nodes that
 * occupy a tightly packed part of route-distance and repeated endpoint artists.
 */
async function compressBalanced(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  budget: GradientRouteBudget,
  mandatoryKeys: Set<string>,
  endpointArtists: [string, string] | null | undefined,
): Promise<BalancedCompression | null> {
  const recordings = [...original.recordings];
  const edges = [...original.edges];
  const mandatory = new Set(mandatoryKeys);
  mandatory.add(recordings[0]!.key);
  mandatory.add(recordings.at(-1)!.key);
  const neighborCache = new Map<string, GradientRecordingNeighbor[]>();
  const removed: Array<{ artist: string; title: string }> = [];
  const endpointSet = new Set((endpointArtists ?? []).map(normalizeForComparison));
  let queries = 0;

  const neighbors = async (recording: GradientRecording) => {
    const cached = neighborCache.get(recording.key);
    if (cached) return cached;
    if (isBudgetExhausted(budget)) return null;
    budget.compressionQueries += 1;
    queries += 1;
    const rows = await provider.neighbors(recording, 48).catch(() => [] as GradientRecordingNeighbor[]);
    neighborCache.set(recording.key, rows);
    return rows;
  };

  while (recordings.length > requestedLength) {
    const totalCost = Math.max(0.000001, edges.reduce((sum, edge) => sum + edgeCost(edge), 0));
    const artistCounts = new Map<string, number>();
    for (const recording of recordings) {
      const artist = normalizeForComparison(recording.artist);
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    }

    let best: { index: number; edge: GradientRecordingPathEdge; score: number } | null = null;
    for (let index = 1; index < recordings.length - 1; index++) {
      const current = recordings[index]!;
      if (mandatory.has(current.key)) continue;
      const prev = recordings[index - 1]!;
      const next = recordings[index + 1]!;
      const rows = await neighbors(prev);
      if (rows == null) return null;
      const match = rows.find((row) => row.key === next.key);
      if (!match || match.similarity < 0.08) continue;

      const skipEdge: GradientRecordingPathEdge = {
        from: prev,
        to: next,
        similarity: match.similarity,
        confidence: match.confidence ?? 0.8,
        provider: match.provider ?? "recording_similarity",
      };
      const oldCost = edgeCost(edges[index - 1]!) + edgeCost(edges[index]!);
      const newCost = edgeCost(skipEdge);
      const localSpanShare = oldCost / totalCost;
      const artist = normalizeForComparison(current.artist);
      const repeats = Math.max(0, (artistCounts.get(artist) ?? 1) - 1);
      const repeatBonus = repeats * 0.12;
      const endpointRepeatBonus = endpointSet.has(artist) && repeats > 0 ? 0.14 : 0;
      // Lower is better: preserve musical cost first, but when choices are
      // comparable, reclaim slots from over-sampled/repeated territory.
      const score = (newCost - oldCost) + localSpanShare * 0.35 - repeatBonus - endpointRepeatBonus;
      if (!best || score < best.score) best = { index, edge: skipEdge, score };
    }

    if (!best) return null;
    const [removedRecording] = recordings.splice(best.index, 1);
    edges.splice(best.index - 1, 2, best.edge);
    if (removedRecording) removed.push({ artist: removedRecording.artist, title: removedRecording.title });
  }

  return {
    path: withPathCost({ ...original, recordings, edges }),
    removed,
    queries,
  };
}

/**
 * Fixed-length route resampling. If one edge consumes a disproportionate share
 * of the musical-route distance, temporarily insert a validated bridge into
 * that exact gap, then reclaim the extra slot from densely packed/repeated
 * territory using another validated skip edge. The route is only changed when
 * the resampled result does not worsen the largest edge share.
 */
export async function repairGradientRecordingPathSpacing(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientSpacingRepairOptions,
): Promise<GradientSpacingRepairResult> {
  const before = gradientMaxEdgeShare(original);
  const threshold = options.maxEdgeShare ?? Math.max(0.24, 2.4 / Math.max(4, requestedLength - 1));
  const baseResult = (path: GradientRecordingPath, operations: GradientSpacingRepairOperation[], queryCount: number, stoppedReason: GradientSpacingRepairResult["stoppedReason"]): GradientSpacingRepairResult => ({
    path,
    positioned: positionGradientRecordingPath(path),
    operations,
    queryCount,
    maxEdgeShareBefore: before,
    maxEdgeShareAfter: gradientMaxEdgeShare(path),
    threshold,
    stoppedReason,
  });

  if (original.recordings.length !== requestedLength || original.edges.length < 3 || before <= threshold) {
    return baseResult(original, [], 0, before <= threshold ? "balanced" : "not_applicable");
  }

  let current = original;
  let queryCount = 0;
  const operations: GradientSpacingRepairOperation[] = [];
  const maxRepairs = Math.max(1, Math.min(3, options.maxRepairs ?? (options.scenic ? 3 : 2)));

  for (let attempt = 0; attempt < maxRepairs; attempt++) {
    if (isBudgetExhausted(options.budget)) return baseResult(current, operations, queryCount, "query_budget");
    const worst = worstGap(current);
    if (!worst || worst.share <= threshold) return baseResult(current, operations, queryCount, "balanced");

    const expanded = await expandWorstGap(current, worst.index, provider, options);
    queryCount += expanded.queries;
    if (!expanded.dense) {
      return baseResult(current, operations, queryCount, isBudgetExhausted(options.budget) ? "query_budget" : "no_bridge");
    }

    const inserted = expanded.dense.path.recordings.slice(1, -1);
    if (!inserted.length) return baseResult(current, operations, queryCount, "no_bridge");

    const recordings = [...current.recordings];
    const edges = [...current.edges];
    recordings.splice(worst.index, 2, ...expanded.dense.path.recordings);
    edges.splice(worst.index, 1, ...expanded.dense.path.edges);
    const expandedPath = withPathCost({
      ...current,
      recordings,
      edges,
      queryCount: current.queryCount + expanded.queries,
    });

    const mandatory = new Set(options.mandatoryKeys ?? []);
    for (const recording of inserted) mandatory.add(recording.key);
    const compressed = await compressBalanced(
      expandedPath,
      requestedLength,
      provider,
      options.budget,
      mandatory,
      options.endpointArtists,
    );
    if (!compressed) {
      return baseResult(current, operations, queryCount, isBudgetExhausted(options.budget) ? "query_budget" : "no_safe_resample");
    }
    queryCount += compressed.queries;

    const after = gradientMaxEdgeShare(compressed.path);
    // Do not spend a playlist rewrite merely to move the cliff elsewhere.
    if (after > worst.share + 0.005) {
      return baseResult(current, operations, queryCount, "no_safe_resample");
    }

    operations.push({
      gapIndex: worst.index,
      gapShareBefore: Number(worst.share.toFixed(4)),
      maxEdgeShareAfter: Number(after.toFixed(4)),
      inserted: inserted.map((recording) => ({ artist: recording.artist, title: recording.title })),
      removed: compressed.removed,
    });
    current = compressed.path;
  }

  return baseResult(current, operations, queryCount, gradientMaxEdgeShare(current) <= threshold ? "balanced" : "repair_limit");
}
