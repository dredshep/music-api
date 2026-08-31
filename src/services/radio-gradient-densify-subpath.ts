import { normalizeForComparison } from "../domain/normalization";
import { searchBalancedFixedHopPath } from "./radio-gradient-balanced-hop-search";
import {
  densifyGradientRecordingPath,
  gradientFamiliarityTarget,
  gradientRecordingEdgeCost,
  searchGradientRecordingPath,
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

export function gradientSpacingProfile(path: GradientRecordingPath) {
  if (!path.edges.length) {
    return { idealShare: 0, maxShare: 0, maxCost: 0, imbalance: 0, shares: [] as number[] };
  }
  const costs = path.edges.map(edgeCost);
  const total = Math.max(0.000001, costs.reduce((sum, value) => sum + value, 0));
  const shares = costs.map((value) => value / total);
  const idealShare = 1 / path.edges.length;
  const imbalance = shares.reduce((sum, share) => sum + Math.abs(share - idealShare), 0)
    / path.edges.length
    / idealShare;
  return {
    idealShare,
    maxShare: Math.max(...shares),
    maxCost: Math.max(...costs),
    imbalance,
    shares,
  };
}

export function gradientMaxEdgeShare(path: GradientRecordingPath) {
  return gradientSpacingProfile(path).maxShare;
}

function spacingRepairThreshold(path: GradientRecordingPath) {
  const ideal = gradientSpacingProfile(path).idealShare;
  // Fixed-length routes should spend their slots across the journey. For ten
  // tracks the natural step is 1/9 ~= 11.1%; start repairing near ~17.8% so
  // 15-17% remains plausible variation but 20%+ transitions are suspect.
  return Math.max(0.095, Math.min(0.26, ideal * 1.6));
}

function worstGap(path: GradientRecordingPath) {
  if (!path.edges.length) return null;
  const costs = path.edges.map(edgeCost);
  const total = Math.max(0.000001, costs.reduce((sum, value) => sum + value, 0));
  let index = 0;
  for (let i = 1; i < costs.length; i++) {
    if (costs[i]! > costs[index]!) index = i;
  }
  return { index, share: costs[index]! / total, cost: costs[index]! };
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
  if (!endpoints || midpoint <= 0.001 || midpoint >= 0.999) return false;
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

  const biNeighbors = provider.bidirectionalNeighbors?.bind(provider);
  const neighbors = async (recording: GradientRecording) => {
    const cached = cache.get(recording.key);
    if (cached) return cached;
    if (queryCount >= maxQueries) return null;
    queryCount++;
    const limit = Math.max(24, Math.min(64, options.neighborLimit ?? 48));
    const rows = await (biNeighbors?.(recording, limit) ?? provider.neighbors(recording, limit))
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
      const match = rows.find((row) => row.key === next.key)
        ?? provider.lookupEdge?.(prev.key, next.key) ?? null;
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

type BalancedReplacementResult = {
  path: GradientRecordingPath | null;
  queryCount: number;
  removed: GradientRecording | null;
  inserted: GradientRecording | null;
};

/**
 * Before growing an exact-length route, try a one-for-one replacement around
 * the dominant cliff. Interior route nodes are not user constraints, so a
 * recording such as Psychosocial may be replaced when another real recording
 * connects both adjacent sides more evenly. Segment endpoints remain sacred.
 */
async function findBalancedGapNodeReplacement(
  path: GradientRecordingPath,
  gapIndex: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  maxQueries: number,
): Promise<BalancedReplacementResult> {
  if (maxQueries < 2 || path.recordings.length < 4) {
    return { path: null, queryCount: 0, removed: null, inserted: null };
  }
  const before = gradientSpacingProfile(path);
  const minBridge = clamp(options.minBridgeSimilarity ?? 0.12, 0.01, 0.95);
  const neighborLimit = Math.max(24, Math.min(64, options.neighborLimit ?? 48));
  const used = new Set(path.recordings.map((row) => row.key));
  const biNeighbors = provider.bidirectionalNeighbors?.bind(provider);
  const cache = new Map<string, GradientRecordingNeighbor[]>();
  let queryCount = 0;

  const neighbors = async (recording: GradientRecording) => {
    const cached = cache.get(recording.key);
    if (cached) return cached;
    if (queryCount >= maxQueries) return [] as GradientRecordingNeighbor[];
    queryCount++;
    const rows = await (biNeighbors?.(recording, neighborLimit) ?? provider.neighbors(recording, neighborLimit))
      .catch(() => [] as GradientRecordingNeighbor[]);
    cache.set(recording.key, rows);
    return rows;
  };

  let best: { path: GradientRecordingPath; removed: GradientRecording; inserted: GradientRecording; score: number } | null = null;
  const candidateIndices = [...new Set([gapIndex, gapIndex + 1])]
    .filter((index) => index > 0 && index < path.recordings.length - 1);

  for (const index of candidateIndices) {
    if (queryCount + 2 > maxQueries) break;
    const prev = path.recordings[index - 1]!;
    const current = path.recordings[index]!;
    const next = path.recordings[index + 1]!;
    const [leftRows, rightRows] = await Promise.all([neighbors(prev), neighbors(next)]);
    const rightByKey = neighborMap(rightRows);
    const position = index / Math.max(1, path.recordings.length - 1);

    for (const leftMatch of leftRows) {
      if (leftMatch.key === current.key || leftMatch.key === prev.key || leftMatch.key === next.key) continue;
      if (used.has(leftMatch.key)) continue;
      const rightMatch = rightByKey.get(leftMatch.key);
      if (!rightMatch) continue;
      if (leftMatch.similarity < minBridge || rightMatch.similarity < minBridge) continue;
      if (sameEndpointArtist(leftMatch, position, options.endpointArtists)) continue;

      const replacement: GradientRecording = {
        key: leftMatch.key,
        artist: leftMatch.artist,
        title: leftMatch.title,
        mbid: leftMatch.mbid ?? rightMatch.mbid ?? null,
      };
      const leftEdge: GradientRecordingPathEdge = {
        from: prev,
        to: replacement,
        similarity: leftMatch.similarity,
        confidence: leftMatch.confidence ?? 0.8,
        provider: leftMatch.provider ?? "recording_similarity",
      };
      const rightEdge: GradientRecordingPathEdge = {
        from: replacement,
        to: next,
        similarity: rightMatch.similarity,
        confidence: rightMatch.confidence ?? 0.8,
        provider: rightMatch.provider ?? "recording_similarity",
      };
      const recordings = [...path.recordings];
      const edges = [...path.edges];
      recordings[index] = replacement;
      edges[index - 1] = leftEdge;
      edges[index] = rightEdge;
      const candidate = withPathCost({ ...path, recordings, edges });
      const after = gradientSpacingProfile(candidate);

      if (after.maxCost >= before.maxCost * 0.96) continue;
      if (after.maxShare >= before.maxShare - 0.005) continue;
      if (after.imbalance >= before.imbalance) continue;
      const score = after.maxShare + after.imbalance * 0.12;
      if (!best || score < best.score) best = { path: candidate, removed: current, inserted: replacement, score };
    }
  }

  return best
    ? { path: best.path, queryCount, removed: best.removed, inserted: best.inserted }
    : { path: null, queryCount, removed: null, inserted: null };
}

type AlternateGapPathResult = {
  path: GradientRecordingPath | null;
  queryCount: number;
};

async function findAlternateGapPath(
  gap: GradientRecordingPath,
  fullPath: GradientRecordingPath,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions,
  maxQueries: number,
): Promise<AlternateGapPathResult> {
  if (gap.recordings.length !== 2 || !gap.edges.length || maxQueries < 4) {
    return { path: null, queryCount: 0 };
  }
  const left = gap.recordings[0]!;
  const right = gap.recordings[1]!;
  const fullPositions = positionGradientRecordingPath(fullPath);
  const gapIndex = fullPath.recordings.findIndex((row) => row.key === left.key);
  const midpoint = gapIndex >= 0
    ? ((fullPositions[gapIndex]?.routePosition ?? 0) + (fullPositions[gapIndex + 1]?.routePosition ?? 1)) / 2
    : 0.5;
  const blocked = new Set(fullPath.recordings.map((row) => row.key));
  blocked.delete(left.key);
  blocked.delete(right.key);

  const alternateProvider: GradientRecordingNeighborProvider = {
    async neighbors(recording, limit) {
      const rows = await provider.neighbors(recording, limit);
      return rows.filter((row) => {
        if (blocked.has(row.key)) return false;
        if (recording.key === left.key && row.key === right.key) return false;
        if (recording.key === right.key && row.key === left.key) return false;
        if (sameEndpointArtist(row, midpoint, options.endpointArtists)) return false;
        return true;
      });
    },
  };

  const result = await searchGradientRecordingPath([left], [right], alternateProvider, {
    maxQueries,
    maxNodes: 1200,
    beamPerSide: 4,
    frontierCap: 140,
    neighborLimit: Math.max(24, Math.min(56, options.neighborLimit ?? 48)),
    refineQueries: 4,
  });
  const candidate = result.path;
  if (!candidate || candidate.recordings.length < 3 || candidate.recordings.length > 6) {
    return { path: null, queryCount: result.queryCount };
  }
  const directCost = edgeCost(gap.edges[0]!);
  const alternateWorstCost = Math.max(...candidate.edges.map(edgeCost));
  if (alternateWorstCost >= directCost * 0.92) {
    return { path: null, queryCount: result.queryCount };
  }
  return { path: candidate, queryCount: result.queryCount };
}

function alternatePathOperations(path: GradientRecordingPath) {
  const targetFamiliarity = gradientFamiliarityTarget(0.5);
  return path.recordings.slice(1, -1).map((recording, index): GradientDensificationOperation => {
    const left = path.recordings[index]!;
    const right = path.recordings[index + 2]!;
    const leftEdge = path.edges[index]!;
    const rightEdge = path.edges[index + 1]!;
    return {
      gapIndex: index,
      left: `${left.artist} — ${left.title}`,
      inserted: `${recording.artist} — ${recording.title}`,
      right: `${right.artist} — ${right.title}`,
      leftSimilarity: leftEdge.similarity,
      rightSimilarity: rightEdge.similarity,
      bottleneck: Math.min(leftEdge.similarity, rightEdge.similarity),
      familiarityTarget: targetFamiliarity,
      familiarityActual: null,
    };
  });
}

type SpacingRepairResult = {
  path: GradientRecordingPath;
  operations: GradientDensificationOperation[];
  queryCount: number;
};

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

  if (gradientMaxEdgeShare(original) <= spacingRepairThreshold(original)) {
    return { path: original, operations: [], queryCount: 0 };
  }

  let current = original;
  let queryCount = 0;
  const operations: GradientDensificationOperation[] = [];

  // First solve the problem we actually have: exactly N tracks means exactly
  // N-1 musical transitions. Search that layered state space directly instead
  // of assuming the arbitrary-length cheapest path is the right skeleton.
  const exactHopBudget = Math.min(44, Math.floor(maxQueries * 0.55));
  if (exactHopBudget >= 12 && provider.lookupEdge && !options.skipExactHopRebalance) {
    const balanced = await searchBalancedFixedHopPath(
      original.recordings[0]!,
      original.recordings.at(-1)!,
      provider,
      {
        requestedLength,
        maxQueries: exactHopBudget,
        neighborLimit: options.neighborLimit,
        beamWidth: 18,
        minSimilarity: Math.min(0.10, options.minBridgeSimilarity ?? 0.12),
        endpointArtists: options.endpointArtists,
        familiarity: options.familiarity,
        maxArtistRepeat: options.maxArtistRepeat,
        popularityBias: options.popularityBias,
        releaseAgeBias: options.releaseAgeBias,
      },
    );
    queryCount += balanced.queryCount;
    if (balanced.path) {
      const before = gradientSpacingProfile(original);
      const after = gradientSpacingProfile(balanced.path);
      const accepted = after.maxCost < before.maxCost * 0.96
        && after.maxShare < before.maxShare - 0.01
        && after.imbalance < before.imbalance;
      console.log(JSON.stringify({
        level: "debug",
        event: "spacing_repair_exact_hop",
        accepted,
        candidatesEvaluated: balanced.candidatesEvaluated,
        queries: balanced.queryCount,
        maxShareBefore: before.maxShare,
        maxShareAfter: after.maxShare,
        maxCostBefore: before.maxCost,
        maxCostAfter: after.maxCost,
        imbalanceBefore: before.imbalance,
        imbalanceAfter: after.imbalance,
        idealShare: before.idealShare,
      }));
      if (accepted) current = balanced.path;
    }
  }

  for (let attempt = 0; attempt < 4 && queryCount < maxQueries; attempt++) {
    const worst = worstGap(current);
    const threshold = spacingRepairThreshold(current);
    if (!worst || worst.share <= threshold) break;
    const beforeProfile = gradientSpacingProfile(current);
    const gap = makeGapPath(current, worst.index);
    const gapLeft = current.recordings[worst.index]!;
    const gapRight = current.recordings[worst.index + 1]!;
    console.log(JSON.stringify({ level: "debug", event: "spacing_repair_attempt", attempt, worstIndex: worst.index, worstShare: worst.share, idealShare: beforeProfile.idealShare, threshold, gapLeft: `${gapLeft.artist} — ${gapLeft.title}`, gapRight: `${gapRight.artist} — ${gapRight.title}`, budgetRemaining: maxQueries - queryCount }));

    const replacementBudget = Math.min(8, maxQueries - queryCount);
    if (replacementBudget >= 2) {
      const replacement = await findBalancedGapNodeReplacement(
        current, worst.index, provider, options, replacementBudget,
      );
      queryCount += replacement.queryCount;
      if (replacement.path) {
        console.log(JSON.stringify({
          level: "debug",
          event: "spacing_repair_node_replaced",
          removed: replacement.removed ? `${replacement.removed.artist} — ${replacement.removed.title}` : null,
          inserted: replacement.inserted ? `${replacement.inserted.artist} — ${replacement.inserted.title}` : null,
          maxShareBefore: beforeProfile.maxShare,
          maxShareAfter: gradientSpacingProfile(replacement.path).maxShare,
        }));
        current = replacement.path;
        continue;
      }
    }

    let bridgePath: GradientRecordingPath | null = null;
    let bridgeOperations: GradientDensificationOperation[] = [];
    let insertedKeys = new Set<string>();
    let bridgeMethod: string | null = null;

    const routeKeys = new Set(current.recordings.map((row) => row.key));
    const singleBudget = Math.min(12, maxQueries - queryCount);
    if (singleBudget > 0) {
      const single = await densifyGradientRecordingPath(gap, 3, provider, {
        ...options,
        maxQueries: singleBudget,
        familiarity: undefined,
        familiarityWeight: 0,
      });
      queryCount += single.queryCount;
      const singleInserted = single.path.recordings.slice(1, -1);
      const hasDuplicate = singleInserted.some((row) => routeKeys.has(row.key));
      if (single.path.recordings.length > 2 && !hasDuplicate) {
        bridgePath = single.path;
        bridgeOperations = single.operations;
        insertedKeys = new Set(singleInserted.map((row) => row.key));
        bridgeMethod = "single";
      }
    }

    if (!bridgePath && maxQueries - queryCount >= 3) {
      const twoBudget = Math.min(18, maxQueries - queryCount);
      const found = await findTwoInteriorBridge(gap, provider, { ...options, familiarity: undefined }, twoBudget);
      queryCount += found.queries;
      if (found.bridge && !routeKeys.has(found.bridge.c.key) && !routeKeys.has(found.bridge.d.key)) {
        bridgeMethod = "two_interior";
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

    if (!bridgePath && maxQueries - queryCount > 16) {
      const alternateBudget = Math.min(36, maxQueries - queryCount - 16);
      const alternate = await findAlternateGapPath(gap, current, provider, options, alternateBudget);
      queryCount += alternate.queryCount;
      if (alternate.path) {
        bridgePath = alternate.path;
        bridgeOperations = alternatePathOperations(alternate.path);
        insertedKeys = new Set(alternate.path.recordings.slice(1, -1).map((row) => row.key));
        bridgeMethod = "alternate_path";
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
      new Set([...insertedKeys]),
    );
    if (!compression) break;
    queryCount += compression.queryCount;

    const afterProfile = gradientSpacingProfile(compression.path);
    const accepted = afterProfile.maxCost < beforeProfile.maxCost * 0.96
      && afterProfile.maxShare < beforeProfile.maxShare - 0.005
      && afterProfile.imbalance < beforeProfile.imbalance;
    console.log(JSON.stringify({
      level: "debug",
      event: "spacing_repair_result",
      bridgeMethod,
      maxShareBefore: beforeProfile.maxShare,
      maxShareAfter: afterProfile.maxShare,
      maxCostBefore: beforeProfile.maxCost,
      maxCostAfter: afterProfile.maxCost,
      imbalanceBefore: beforeProfile.imbalance,
      imbalanceAfter: afterProfile.imbalance,
      idealShare: beforeProfile.idealShare,
      threshold,
      accepted,
      compressionQueries: compression.queryCount,
      removedTracks: compression.removed.map((r) => `${r.artist} — ${r.title}`),
    }));
    if (!accepted) break;

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
  // Cached exact-hop minimax can succeed with zero live queries and no local
  // insert/replace operations. Treat a changed recording sequence as success;
  // the previous queryCount/operations gate discarded that accepted path.
  const pathChanged = repaired.path.recordings.length !== result.path.recordings.length
    || repaired.path.recordings.some((row, index) => row.key !== result.path.recordings[index]?.key);
  if (!pathChanged) return result;
  return {
    path: repaired.path,
    positioned: positionGradientRecordingPath(repaired.path),
    operations: [...result.operations, ...repaired.operations],
    queryCount: result.queryCount + repaired.queryCount,
    stoppedReason: "requested_length",
  };
}

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
