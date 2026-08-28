import { normalizeForComparison } from "../domain/normalization";
import {
  densifyGradientRecordingPath,
  gradientFamiliarityTarget,
  gradientRecordingEdgeCost,
  positionGradientRecordingPath,
  type GradientDensificationOperation,
  type GradientDensificationResult,
  type GradientDensifyOptions,
  type GradientRecording,
  type GradientRecordingNeighbor,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "./radio-gradient-recording-path";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function edgeStrength(edge: GradientRecordingPathEdge | undefined) {
  return edge ? edge.similarity * edge.confidence : 0;
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

function sameEndpointArtist(
  recording: GradientRecording,
  midpoint: number,
  endpoints: [string, string] | null | undefined,
) {
  if (!endpoints || midpoint < 0.22 || midpoint > 0.78) return false;
  const artist = normalizeForComparison(recording.artist);
  return endpoints.map(normalizeForComparison).includes(artist);
}

function neighborMap(rows: GradientRecordingNeighbor[]) {
  return new Map(rows.map((row) => [row.key, row]));
}

type TwoInteriorBridge = {
  gapIndex: number;
  c: GradientRecordingNeighbor;
  d: GradientRecordingNeighbor;
  cToD: GradientRecordingNeighbor;
  score: number;
  bottleneck: number;
  midpoint: number;
};

async function findTwoInteriorBridge(
  path: GradientRecordingPath,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  maxQueries: number,
) {
  if (maxQueries < 3 || path.recordings.length < 2) return { bridge: null as TwoInteriorBridge | null, queries: 0 };
  const positioned = positionGradientRecordingPath(path);
  const used = new Set(path.recordings.map((row) => row.key));
  const gaps = path.edges
    .map((edge, gapIndex) => ({ gapIndex, strength: edgeStrength(edge) }))
    .sort((a, b) => a.strength - b.strength || a.gapIndex - b.gapIndex);
  const neighborLimit = Math.max(12, Math.min(64, options.neighborLimit ?? 48));
  const minBridge = clamp(options.minBridgeSimilarity ?? 0.12, 0.01, 0.95);
  let queries = 0;
  let best: TwoInteriorBridge | null = null;

  for (const { gapIndex } of gaps.slice(0, 4)) {
    if (queries + 2 > maxQueries) break;
    const left = path.recordings[gapIndex]!;
    const right = path.recordings[gapIndex + 1]!;
    const [leftRows, rightRows] = await Promise.all([
      provider.neighbors(left, neighborLimit).catch(() => [] as GradientRecordingNeighbor[]),
      provider.neighbors(right, neighborLimit).catch(() => [] as GradientRecordingNeighbor[]),
    ]);
    queries += 2;
    const rightByKey = neighborMap(rightRows);
    const midpoint = ((positioned[gapIndex]?.routePosition ?? 0) + (positioned[gapIndex + 1]?.routePosition ?? 1)) / 2;
    const targetFamiliarity = gradientFamiliarityTarget(midpoint);

    const leftCandidates = leftRows
      .filter((row) => !used.has(row.key) && row.similarity >= minBridge && !sameEndpointArtist(row, midpoint, options.endpointArtists))
      .sort((a, b) => b.similarity * (b.confidence ?? 0.75) - a.similarity * (a.confidence ?? 0.75))
      .slice(0, 8);

    for (const c of leftCandidates) {
      if (queries >= maxQueries) break;
      const cRows = await provider.neighbors(c, neighborLimit).catch(() => [] as GradientRecordingNeighbor[]);
      queries++;
      for (const cToD of cRows) {
        const d = rightByKey.get(cToD.key);
        if (!d || used.has(d.key) || d.key === c.key) continue;
        if (sameEndpointArtist(d, midpoint, options.endpointArtists)) continue;
        const bottleneck = Math.min(c.similarity, cToD.similarity, d.similarity);
        if (bottleneck < minBridge) continue;
        const cFamiliarity = options.familiarity?.(c) ?? null;
        const dFamiliarity = options.familiarity?.(d) ?? null;
        const familiarValues = [cFamiliarity, dFamiliarity].filter((value): value is number => value != null);
        const familiarity = familiarValues.length
          ? familiarValues.reduce((sum, value) => sum + value, 0) / familiarValues.length
          : null;
        const familiarityFit = familiarity == null ? 0.5 : 1 - Math.abs(familiarity - targetFamiliarity);
        const geometric = Math.cbrt(
          clamp(c.similarity, 0.01, 1)
          * clamp(cToD.similarity, 0.01, 1)
          * clamp(d.similarity, 0.01, 1),
        );
        const score = bottleneck * 0.7 + geometric * 0.22 + familiarityFit * 0.08;
        if (!best || score > best.score) best = { gapIndex, c, d, cToD, score, bottleneck, midpoint };
      }
    }
    if (best) break;
  }
  return { bridge: best, queries };
}

function bridgeEdges(
  left: GradientRecording,
  right: GradientRecording,
  bridge: TwoInteriorBridge,
): GradientRecordingPathEdge[] {
  return [
    {
      from: left,
      to: bridge.c,
      similarity: clamp(bridge.c.similarity, 0.01, 1),
      confidence: clamp(bridge.c.confidence ?? 0.8, 0.05, 1),
      provider: bridge.c.provider ?? "recording_similarity",
    },
    {
      from: bridge.c,
      to: bridge.d,
      similarity: clamp(bridge.cToD.similarity, 0.01, 1),
      confidence: clamp(bridge.cToD.confidence ?? 0.8, 0.05, 1),
      provider: bridge.cToD.provider ?? "recording_similarity",
    },
    {
      from: bridge.d,
      to: right,
      similarity: clamp(bridge.d.similarity, 0.01, 1),
      confidence: clamp(bridge.d.confidence ?? 0.8, 0.05, 1),
      provider: bridge.d.provider ?? "recording_similarity",
    },
  ];
}

function makeGapPath(path: GradientRecordingPath, gapIndex: number): GradientRecordingPath {
  const edge = path.edges[gapIndex]!;
  return {
    recordings: [path.recordings[gapIndex]!, path.recordings[gapIndex + 1]!],
    edges: [edge],
    cost: edgeCost(edge),
    queryCount: 0,
    nodesVisited: 2,
    forwardFrontierSize: 0,
    backwardFrontierSize: 0,
    intersection: null,
  };
}

type FixedLengthCompression = {
  path: GradientRecordingPath;
  removed: GradientRecording[];
  queryCount: number;
};

/**
 * Reclaim slots after a targeted gap insertion. Every removal requires a real
 * validated prev->next edge. When several removals are safe, prefer reclaiming
 * tightly packed slots and repeated endpoint artists instead of moving the cliff.
 */
async function compressFixedLengthBalanced(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  maxQueries: number,
  protectedKeys: Set<string>,
): Promise<FixedLengthCompression | null> {
  const recordings = [...original.recordings];
  const edges = [...original.edges];
  const protectedSet = new Set(protectedKeys);
  protectedSet.add(recordings[0]!.key);
  protectedSet.add(recordings.at(-1)!.key);
  const endpointArtists = new Set((options.endpointArtists ?? []).map(normalizeForComparison));
  const cache = new Map<string, GradientRecordingNeighbor[]>();
  const removed: GradientRecording[] = [];
  let queryCount = 0;

  const neighbors = async (recording: GradientRecording) => {
    const cached = cache.get(recording.key);
    if (cached) return cached;
    if (queryCount >= maxQueries) return null;
    queryCount++;
    const rows = await provider.neighbors(recording, Math.max(24, Math.min(64, options.neighborLimit ?? 48)))
      .catch(() => [] as GradientRecordingNeighbor[]);
    cache.set(recording.key, rows);
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
      if (protectedSet.has(current.key)) continue;
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
      const endpointRepeatBonus = endpointArtists.has(artist) && repeats > 0 ? 0.14 : 0;
      const score = (newCost - oldCost) + localSpanShare * 0.35 - repeatBonus - endpointRepeatBonus;
      if (!best || score < best.score) best = { index, edge: skipEdge, score };
    }

    if (!best) return null;
    const [removedRecording] = recordings.splice(best.index, 1);
    edges.splice(best.index - 1, 2, best.edge);
    if (removedRecording) removed.push(removedRecording);
  }

  return {
    path: withPathCost({ ...original, recordings, edges }),
    removed,
    queryCount,
  };
}

type SpacingRepairResult = {
  path: GradientRecordingPath;
  operations: GradientDensificationOperation[];
  queryCount: number;
};

/**
 * Fixed-length route resampling. If one edge consumes a disproportionate share
 * of total musical-route distance, temporarily insert one or two validated
 * recordings into that exact gap and reclaim the same number of slots elsewhere
 * through validated skip edges. This lets a 10-track route repair a 14%->50%
 * cliff instead of declaring success merely because it already has 10 nodes.
 */
async function repairFixedLengthSpacing(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  maxQueries: number,
): Promise<SpacingRepairResult> {
  if (original.recordings.length !== requestedLength || original.edges.length < 3 || maxQueries <= 0) {
    return { path: original, operations: [], queryCount: 0 };
  }

  const threshold = Math.max(0.24, Math.min(0.34, 2.4 / Math.max(4, requestedLength - 1)));
  if (gradientMaxEdgeShare(original) <= threshold) return { path: original, operations: [], queryCount: 0 };

  let current = original;
  let queryCount = 0;
  const operations: GradientDensificationOperation[] = [];

  for (let attempt = 0; attempt < 2 && queryCount < maxQueries; attempt++) {
    const worst = worstGap(current);
    if (!worst || worst.share <= threshold) break;
    const gap = makeGapPath(current, worst.index);
    let bridgePath: GradientRecordingPath | null = null;
    let bridgeOperations: GradientDensificationOperation[] = [];
    let insertedKeys = new Set<string>();

    const singleBudget = Math.min(24, maxQueries - queryCount);
    if (singleBudget > 0) {
      const single = await densifyGradientRecordingPath(gap, 3, provider, {
        ...options,
        maxQueries: singleBudget,
        familiarity: undefined,
        familiarityWeight: 0,
      });
      queryCount += single.queryCount;
      if (single.path.recordings.length > 2) {
        bridgePath = single.path;
        bridgeOperations = single.operations;
        insertedKeys = new Set(single.path.recordings.slice(1, -1).map((row) => row.key));
      }
    }

    if (!bridgePath && maxQueries - queryCount >= 3) {
      const twoBudget = Math.min(36, maxQueries - queryCount);
      const found = await findTwoInteriorBridge(gap, provider, { ...options, familiarity: undefined }, twoBudget);
      queryCount += found.queries;
      if (found.bridge) {
        const left = gap.recordings[0]!;
        const right = gap.recordings[1]!;
        const newEdges = bridgeEdges(left, right, found.bridge);
        bridgePath = withPathCost({
          ...gap,
          recordings: [left, found.bridge.c, found.bridge.d, right],
          edges: newEdges,
          queryCount: gap.queryCount + found.queries,
        });
        insertedKeys = new Set([found.bridge.c.key, found.bridge.d.key]);
        const targetFamiliarity = gradientFamiliarityTarget(found.bridge.midpoint);
        bridgeOperations = [
          {
            gapIndex: 0,
            left: `${left.artist} — ${left.title}`,
            inserted: `${found.bridge.c.artist} — ${found.bridge.c.title}`,
            right: `${found.bridge.d.artist} — ${found.bridge.d.title}`,
            leftSimilarity: newEdges[0]!.similarity,
            rightSimilarity: newEdges[1]!.similarity,
            bottleneck: found.bridge.bottleneck,
            familiarityTarget: targetFamiliarity,
            familiarityActual: null,
          },
          {
            gapIndex: 1,
            left: `${found.bridge.c.artist} — ${found.bridge.c.title}`,
            inserted: `${found.bridge.d.artist} — ${found.bridge.d.title}`,
            right: `${right.artist} — ${right.title}`,
            leftSimilarity: newEdges[1]!.similarity,
            rightSimilarity: newEdges[2]!.similarity,
            bottleneck: found.bridge.bottleneck,
            familiarityTarget: targetFamiliarity,
            familiarityActual: null,
          },
        ];
      }
    }

    if (!bridgePath || !insertedKeys.size) break;

    const recordings = [...current.recordings];
    const edges = [...current.edges];
    recordings.splice(worst.index, 2, ...bridgePath.recordings);
    edges.splice(worst.index, 1, ...bridgePath.edges);
    const expanded = withPathCost({
      ...current,
      recordings,
      edges,
      queryCount: current.queryCount + queryCount,
    });

    const compression = await compressFixedLengthBalanced(
      expanded,
      requestedLength,
      provider,
      options,
      maxQueries - queryCount,
      insertedKeys,
    );
    if (!compression) break;
    queryCount += compression.queryCount;

    const after = gradientMaxEdgeShare(compression.path);
    if (after > worst.share + 0.005) break;

    // Translate the gap-local operation index back to the full route so
    // diagnostics still identify the repaired transition.
    operations.push(...bridgeOperations.map((operation) => ({
      ...operation,
      gapIndex: worst.index + operation.gapIndex,
    })));
    current = compression.path;
  }

  return { path: current, operations, queryCount };
}

async function addFixedLengthSpacingRepair(
  result: GradientDensificationResult,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  totalBudget: number,
): Promise<GradientDensificationResult> {
  if (result.path.recordings.length !== requestedLength) return result;
  const remaining = Math.max(0, totalBudget - result.queryCount);
  if (!remaining) return result;
  const repaired = await repairFixedLengthSpacing(result.path, requestedLength, provider, options, remaining);
  if (!repaired.queryCount && !repaired.operations.length) return result;
  return {
    path: repaired.path,
    positioned: positionGradientRecordingPath(repaired.path),
    operations: [...result.operations, ...repaired.operations],
    queryCount: result.queryCount + repaired.queryCount,
    stoppedReason: "requested_length",
  };
}

/**
 * Normal densification prefers a single bottleneck-safe common neighbor. If it
 * exhausts that option, probe a few weak gaps for a bounded C→D connector and
 * then resume normal densification. `maxQueries` is a hard total budget across
 * all phases, including fixed-length spacing repair.
 */
export async function densifyGradientRecordingPathWithSubpathFallback(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions = {},
): Promise<GradientDensificationResult> {
  const totalBudget = Math.max(0, options.maxQueries ?? 96);
  const first = await densifyGradientRecordingPath(original, requestedLength, provider, {
    ...options,
    maxQueries: totalBudget,
  });
  if (first.path.recordings.length >= requestedLength) {
    return addFixedLengthSpacingRepair(first, requestedLength, provider, options, totalBudget);
  }
  if (first.stoppedReason !== "no_bridge") return first;
  if (requestedLength - first.path.recordings.length < 2) return first;

  let remainingBudget = Math.max(0, totalBudget - first.queryCount);
  const fallbackBudget = Math.min(28, Math.floor(totalBudget / 3), remainingBudget);
  if (fallbackBudget < 3) {
    return { ...first, stoppedReason: remainingBudget === 0 ? "query_budget" : first.stoppedReason };
  }

  const found = await findTwoInteriorBridge(first.path, provider, options, fallbackBudget);
  remainingBudget = Math.max(0, remainingBudget - found.queries);
  const consumed = first.queryCount + found.queries;
  if (!found.bridge) {
    return {
      ...first,
      queryCount: consumed,
      path: { ...first.path, queryCount: first.path.queryCount + found.queries },
      stoppedReason: remainingBudget === 0 ? "query_budget" : "no_bridge",
    };
  }

  const recordings = [...first.path.recordings];
  const edges = [...first.path.edges];
  const gap = found.bridge.gapIndex;
  const left = recordings[gap]!;
  const right = recordings[gap + 1]!;
  const newEdges = bridgeEdges(left, right, found.bridge);
  recordings.splice(gap + 1, 0, found.bridge.c, found.bridge.d);
  edges.splice(gap, 1, ...newEdges);
  const insertedPath: GradientRecordingPath = withPathCost({
    ...first.path,
    recordings,
    edges,
    queryCount: first.path.queryCount + found.queries,
  });
  const targetFamiliarity = gradientFamiliarityTarget(found.bridge.midpoint);
  const operations: GradientDensificationOperation[] = [
    ...first.operations,
    {
      gapIndex: gap,
      left: `${left.artist} — ${left.title}`,
      inserted: `${found.bridge.c.artist} — ${found.bridge.c.title}`,
      right: `${found.bridge.d.artist} — ${found.bridge.d.title}`,
      leftSimilarity: newEdges[0]!.similarity,
      rightSimilarity: newEdges[1]!.similarity,
      bottleneck: found.bridge.bottleneck,
      familiarityTarget: targetFamiliarity,
      familiarityActual: options.familiarity?.(found.bridge.c) ?? null,
    },
    {
      gapIndex: gap + 1,
      left: `${found.bridge.c.artist} — ${found.bridge.c.title}`,
      inserted: `${found.bridge.d.artist} — ${found.bridge.d.title}`,
      right: `${right.artist} — ${right.title}`,
      leftSimilarity: newEdges[1]!.similarity,
      rightSimilarity: newEdges[2]!.similarity,
      bottleneck: found.bridge.bottleneck,
      familiarityTarget: targetFamiliarity,
      familiarityActual: options.familiarity?.(found.bridge.d) ?? null,
    },
  ];

  if (recordings.length >= requestedLength) {
    return addFixedLengthSpacingRepair({
      path: insertedPath,
      positioned: positionGradientRecordingPath(insertedPath),
      operations,
      queryCount: consumed,
      stoppedReason: "requested_length",
    }, requestedLength, provider, options, totalBudget);
  }

  if (remainingBudget === 0) {
    return {
      path: insertedPath,
      positioned: positionGradientRecordingPath(insertedPath),
      operations,
      queryCount: consumed,
      stoppedReason: "query_budget",
    };
  }

  const second = await densifyGradientRecordingPath(insertedPath, requestedLength, provider, {
    ...options,
    maxQueries: remainingBudget,
  });
  return addFixedLengthSpacingRepair({
    ...second,
    operations: [...operations, ...second.operations],
    queryCount: consumed + second.queryCount,
  }, requestedLength, provider, options, totalBudget);
}
