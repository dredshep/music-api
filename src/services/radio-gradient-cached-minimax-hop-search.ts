import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import { Semaphore } from "../middleware/semaphore";
import { canonicalRadioTrackKey } from "./radio";
import {
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "./radio-gradient-recording-path";
import {
  assessAcousticTransition,
  loadCachedAcousticFeatures,
  type CachedAcousticFeatures,
} from "./radio-transition-quality";

const ALGORITHM_VERSION = 2;
const SOLUTION_CACHE_MAX = 64;

const minimaxSemaphore = new Semaphore(2, "minimax search");

type SolutionCacheEntry = {
  result: CachedBalancedHopSearchResult;
  graphVersion: string;
  createdAt: number;
};

const solutionCache = new Map<string, SolutionCacheEntry>();

function solutionCacheKey(startKey: string, endKey: string, length: number, minSimilarity: number): string {
  return `${startKey}|${endKey}|${length}|${minSimilarity.toFixed(4)}|v${ALGORITHM_VERSION}`;
}

function graphVersion(): string {
  const db = getDb();
  const nodeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM recording_similarity_nodes").get()!.c;
  const edgeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM recording_similarity_edges").get()!.c;
  const lastEdge = db.query<{ r: string | null }, []>(
    "SELECT MAX(retrieved_at) AS r FROM recording_similarity_edges",
  ).get()?.r ?? "";
  const analysisCount = db.query<{ c: number }, []>(
    "SELECT COUNT(*) AS c FROM track_audio_analysis WHERE status='ready'",
  ).get()!.c;
  return `${nodeCount}:${edgeCount}:${analysisCount}:${lastEdge}`;
}

/** Clear the in-process minimax solution cache (e.g. after graph mutation). */
export function clearMinimaxSolutionCache(): void {
  solutionCache.clear();
}

export type CachedBalancedHopSearchOptions = {
  requestedLength: number;
  minSimilarity?: number;
  endpointArtists?: [string, string] | null;
  familiarity?: (recording: GradientRecording) => number | null;
  maxGraphNodes?: number;
  maxGraphEdges?: number;
  statesPerNode?: number;
};

export type CachedBalancedHopSearchResult = {
  path: GradientRecordingPath | null;
  queryCount: number;
  candidatesEvaluated: number;
  graphNodes: number;
  graphEdges: number;
};

type NodeRow = {
  canonical_key: string;
  artist: string;
  title: string;
  recording_mbid: string | null;
};

type EdgeRow = {
  source_key: string;
  target_key: string;
  provider: string;
  similarity: number;
  confidence: number;
};

type Evidence = {
  provider: string;
  similarity: number;
  confidence: number;
};

type EdgeAggregate = {
  best: Evidence;
  providers: Set<string>;
};

type CompactEdge = {
  targetId: number;
  cost: number;
  similarity: number;
  confidence: number;
  provider: string;
};

type DPState = {
  nodeId: number;
  parentIdx: number;
  maxCost: number;
  totalCost: number;
  sumSquares: number;
  repeatedArtistPenalty: number;
  familiarityPenalty: number;
  edgeSimilarity: number;
  edgeConfidence: number;
  edgeProvider: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function strength(similarity: number, confidence: number) {
  return clamp(similarity, 0.01, 1) * clamp(confidence, 0.05, 1);
}

function normalizedArtist(recording: GradientRecording) {
  return normalizeForComparison(recording.artist);
}

function endpointArtistBlocked(
  recording: GradientRecording,
  depth: number,
  totalEdges: number,
  endpoints: [string, string] | null | undefined,
) {
  if (!endpoints || totalEdges <= 1) return false;
  const position = depth / totalEdges;
  if (position < 0.22 || position > 0.78) return false;
  const artist = normalizedArtist(recording);
  return endpoints.map(normalizeForComparison).includes(artist);
}

function spacingMetrics(edges: GradientRecordingPathEdge[]) {
  const costs = edges.map((edge) => gradientRecordingEdgeCost(edge.similarity, edge.confidence));
  const total = Math.max(0.000001, costs.reduce((sum, cost) => sum + cost, 0));
  const ideal = 1 / Math.max(1, costs.length);
  const shares = costs.map((cost) => cost / total);
  return {
    maxCost: costs.length ? Math.max(...costs) : 0,
    total,
    maxShare: shares.length ? Math.max(...shares) : 0,
    imbalance: shares.length
      ? shares.reduce((sum, share) => sum + Math.abs(share - ideal), 0) / shares.length / ideal
      : 0,
  };
}

function partialVarianceFromScalars(totalCost: number, sumSquares: number, count: number) {
  const n = Math.max(1, count);
  const mean = totalCost / n;
  return Math.max(0, sumSquares / n - mean * mean);
}

function comparePartialScalars(
  aMax: number, aTotalCost: number, aSumSq: number, aRepeat: number, aFam: number,
  bMax: number, bTotalCost: number, bSumSq: number, bRepeat: number, bFam: number,
  depth: number,
): number {
  if (Math.abs(aMax - bMax) > 1e-9) return aMax - bMax;
  const aVar = partialVarianceFromScalars(aTotalCost, aSumSq, depth);
  const bVar = partialVarianceFromScalars(bTotalCost, bSumSq, depth);
  if (Math.abs(aVar - bVar) > 1e-9) return aVar - bVar;
  if (Math.abs(aRepeat - bRepeat) > 1e-9) return aRepeat - bRepeat;
  if (Math.abs(aFam - bFam) > 1e-9) return aFam - bFam;
  return aTotalCost - bTotalCost;
}

/**
 * Exact-hop minimax search over the already-persisted recording graph.
 *
 * Optimized implementation using:
 * - integer node IDs and pre-validated compact adjacency
 * - parent-pointer DP states (no array/Set copies per candidate)
 * - branch-and-bound with greedy initial upper bound
 * - backward-reachability pruning per remaining hops
 * - early candidate rejection before state allocation
 * - last-depth direct lookup (skip neighbor scan at final hop)
 * - in-process solution cache keyed by graph revision
 * - concurrency semaphore (max 2 simultaneous searches)
 */
export function searchCachedBalancedFixedHopPath(
  start: GradientRecording,
  end: GradientRecording,
  options: CachedBalancedHopSearchOptions,
): CachedBalancedHopSearchResult {
  if (!minimaxSemaphore.acquire()) {
    return { path: null, queryCount: 0, candidatesEvaluated: 0, graphNodes: 0, graphEdges: 0 };
  }
  try {
    return searchCachedBalancedFixedHopPathInner(start, end, options);
  } finally {
    minimaxSemaphore.release();
  }
}

function searchCachedBalancedFixedHopPathInner(
  start: GradientRecording,
  end: GradientRecording,
  options: CachedBalancedHopSearchOptions,
): CachedBalancedHopSearchResult {
  const requestedLength = Math.max(2, Math.floor(options.requestedLength));
  const totalEdges = requestedLength - 1;
  const minSimilarity = clamp(options.minSimilarity ?? 0.08, 0.01, 0.95);

  // Solution cache: return previous result if graph hasn't changed
  const cacheKey = solutionCacheKey(start.key, end.key, requestedLength, minSimilarity);
  const gv = graphVersion();
  const cached = solutionCache.get(cacheKey);
  if (cached && cached.graphVersion === gv) return cached.result;
  const maxGraphNodes = Math.max(100, options.maxGraphNodes ?? 50_000);
  const maxGraphEdges = Math.max(100, options.maxGraphEdges ?? 500_000);
  const statesPerNode = Math.max(1, Math.min(4, options.statesPerNode ?? 2));
  const db = getDb();

  const nodeRows = db.query<NodeRow, []>(
    "SELECT canonical_key,artist,title,recording_mbid FROM recording_similarity_nodes",
  ).all();
  const edgeRows = db.query<EdgeRow, []>(
    "SELECT source_key,target_key,provider,similarity,confidence FROM recording_similarity_edges",
  ).all();
  if (nodeRows.length > maxGraphNodes || edgeRows.length > maxGraphEdges) {
    return { path: null, queryCount: 0, candidatesEvaluated: 0, graphNodes: nodeRows.length, graphEdges: edgeRows.length };
  }

  // ── Build compact integer-indexed node list ──
  const nodeCount = nodeRows.length;
  const nodeIndex = new Map<string, number>();
  const nodeList: GradientRecording[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const row = nodeRows[i]!;
    nodeIndex.set(row.canonical_key, i);
    nodeList[i] = { key: row.canonical_key, artist: row.artist, title: row.title, mbid: row.recording_mbid };
  }

  const startId = nodeIndex.get(start.key);
  const endId = nodeIndex.get(end.key);
  if (startId == null || endId == null) {
    return { path: null, queryCount: 0, candidatesEvaluated: 0, graphNodes: nodeCount, graphEdges: edgeRows.length };
  }
  nodeList[startId] = start;
  nodeList[endId] = end;

  // Pre-cache normalized artists and endpoint blocking set
  const normArtists: string[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) normArtists[i] = normalizeForComparison(nodeList[i]!.artist);

  const endpointArtistSet = options.endpointArtists
    ? new Set(options.endpointArtists.map(normalizeForComparison))
    : null;

  // ── Build evidence aggregation with integer IDs ──
  // Use parallel arrays instead of nested Maps for the aggregation phase.
  // Key: encode (fromId, toId) pair. Use a Map<number, Map<number, EdgeAggregate>>.
  const aggMap = new Map<number, Map<number, EdgeAggregate>>();

  function addEvidence(fromId: number, toId: number, ev: Evidence) {
    if (fromId === toId) return;
    let bucket = aggMap.get(fromId);
    if (!bucket) { bucket = new Map(); aggMap.set(fromId, bucket); }
    const cur = bucket.get(toId);
    if (!cur) {
      bucket.set(toId, { best: ev, providers: new Set([ev.provider]) });
      return;
    }
    cur.providers.add(ev.provider);
    if (strength(ev.similarity, ev.confidence) > strength(cur.best.similarity, cur.best.confidence)) {
      cur.best = ev;
    }
  }

  for (let i = 0; i < edgeRows.length; i++) {
    const row = edgeRows[i]!;
    const srcId = nodeIndex.get(row.source_key);
    const tgtId = nodeIndex.get(row.target_key);
    if (srcId == null || tgtId == null) continue;
    const ev: Evidence = {
      provider: row.provider,
      similarity: clamp(row.similarity, 0.01, 1),
      confidence: clamp(row.confidence, 0.05, 1),
    };
    addEvidence(srcId, tgtId, ev);
    addEvidence(tgtId, srcId, ev);
  }

  // ── Pre-validate all edges, build compact sorted adjacency ──
  const featureCache = new Map<number, CachedAcousticFeatures | null>();
  function getFeatures(nodeId: number): CachedAcousticFeatures | null {
    const cached = featureCache.get(nodeId);
    if (cached !== undefined) return cached;
    const rec = nodeList[nodeId]!;
    let value: CachedAcousticFeatures | null = null;
    try { value = loadCachedAcousticFeatures(canonicalRadioTrackKey(rec.artist, rec.title)); }
    catch { value = null; }
    featureCache.set(nodeId, value);
    return value;
  }

  const adj: CompactEdge[][] = new Array(nodeCount);
  const edgeToEnd: (CompactEdge | null)[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) edgeToEnd[i] = null;

  for (let srcId = 0; srcId < nodeCount; srcId++) {
    const neighbors = aggMap.get(srcId);
    if (!neighbors) { adj[srcId] = []; continue; }
    const edges: CompactEdge[] = [];
    for (const [tgtId, agg] of neighbors) {
      if (agg.best.similarity < minSimilarity) continue;
      let confidence = clamp(
        agg.best.confidence + Math.min(0.18, Math.max(0, agg.providers.size - 1) * 0.09),
        0.05, 1,
      );
      let assessment;
      try { assessment = assessAcousticTransition(getFeatures(srcId), getFeatures(tgtId)); }
      catch { assessment = null; }
      if (assessment?.catastrophic) continue;
      if (assessment && assessment.evidenceCount >= 3 && assessment.score != null) {
        if (assessment.score < 0.35) confidence *= clamp(assessment.score / 0.35, 0.35, 1);
        else if (assessment.score >= 0.72) confidence = clamp(confidence + 0.06, 0.05, 1);
      }
      confidence = clamp(confidence, 0.05, 1);
      const cost = gradientRecordingEdgeCost(agg.best.similarity, confidence);
      const edge: CompactEdge = { targetId: tgtId, cost, similarity: agg.best.similarity, confidence, provider: agg.best.provider };
      edges.push(edge);
      if (tgtId === endId) edgeToEnd[srcId] = edge;
    }
    edges.sort((a, b) => a.cost - b.cost || a.targetId - b.targetId);
    adj[srcId] = edges;
  }

  aggMap.clear();

  // ── Backward reachability: min hops from each node to endId ──
  const minHopsToEnd = new Int8Array(nodeCount).fill(-1);
  minHopsToEnd[endId] = 0;

  // Build reverse adjacency for backward BFS
  const revNeighborCount = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    for (const e of adj[i]!) revNeighborCount[e.targetId]++;
  }
  const revOffsets = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) revOffsets[i + 1] = revOffsets[i]! + revNeighborCount[i]!;
  const revTargets = new Int32Array(revOffsets[nodeCount]!);
  const revFill = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    for (const e of adj[i]!) {
      const t = e.targetId;
      revTargets[revOffsets[t]! + revFill[t]!] = i;
      revFill[t]!++;
    }
  }

  let bfsQueue = [endId];
  for (let hop = 1; hop <= totalEdges && bfsQueue.length > 0; hop++) {
    const nextBfs: number[] = [];
    for (const nodeId of bfsQueue) {
      const start = revOffsets[nodeId]!;
      const end = revOffsets[nodeId + 1]!;
      for (let j = start; j < end; j++) {
        const pred = revTargets[j]!;
        if (minHopsToEnd[pred] === -1) {
          minHopsToEnd[pred] = hop as unknown as number;
          nextBfs.push(pred);
        }
      }
    }
    bfsQueue = nextBfs;
  }

  // ── Greedy minimax for initial branch-and-bound upper bound ──
  // The greedy must respect the same constraints as the DP (endpoint blocking,
  // reachability) to avoid setting an impossibly tight bound.
  let upperBound = Infinity;
  {
    let current = startId;
    const visited = new Set<number>([startId]);
    let greedyMax = 0;
    let ok = true;
    for (let d = 1; d <= totalEdges; d++) {
      const remaining = totalEdges - d;
      if (d === totalEdges) {
        const e = edgeToEnd[current];
        if (e && !visited.has(endId)) {
          greedyMax = Math.max(greedyMax, e.cost);
        } else { ok = false; }
        break;
      }
      const pos = d / totalEdges;
      const blockEndpoint = endpointArtistSet && totalEdges > 1
        && pos >= 0.22 && pos <= 0.78;
      let picked: CompactEdge | null = null;
      for (const e of adj[current]!) {
        if (visited.has(e.targetId)) continue;
        if (e.targetId === startId || e.targetId === endId) continue;
        const hops = minHopsToEnd[e.targetId];
        if (hops === -1 || hops > remaining) continue;
        if (blockEndpoint && endpointArtistSet!.has(normArtists[e.targetId]!)) continue;
        picked = e;
        break;
      }
      if (!picked) { ok = false; break; }
      greedyMax = Math.max(greedyMax, picked.cost);
      visited.add(picked.targetId);
      current = picked.targetId;
    }
    if (ok) upperBound = greedyMax;
  }

  // ── Layered DP with parent-pointer states ──
  const statePool: DPState[] = [];
  statePool.push({
    nodeId: startId,
    parentIdx: -1,
    maxCost: 0,
    totalCost: 0,
    sumSquares: 0,
    repeatedArtistPenalty: 0,
    familiarityPenalty: 0,
    edgeSimilarity: 0,
    edgeConfidence: 0,
    edgeProvider: "",
  });

  function isVisited(stateIdx: number, targetId: number): boolean {
    let idx = stateIdx;
    while (idx >= 0) {
      if (statePool[idx]!.nodeId === targetId) return true;
      idx = statePool[idx]!.parentIdx;
    }
    return false;
  }

  let layer = new Map<number, number[]>();
  layer.set(startId, [0]);
  let candidatesEvaluated = 0;
  const nodesVisited = new Set<number>([startId]);

  for (let depth = 1; depth <= totalEdges; depth++) {
    const next = new Map<number, number[]>();
    const remainingAfterThis = totalEdges - depth;
    const isLastDepth = depth === totalEdges;
    const checkEndpointBlock = !isLastDepth && endpointArtistSet && totalEdges > 1;
    const endpointBlockMin = 0.22;
    const endpointBlockMax = 0.78;
    const position = depth / totalEdges;
    const positionInRange = position >= endpointBlockMin && position <= endpointBlockMax;
    const checkFamiliarity = !isLastDepth && options.familiarity != null;
    const familiarityPosition = depth / totalEdges;
    const familiarityDesired = Math.pow(Math.abs(familiarityPosition * 2 - 1), 0.72);

    for (const stateIndices of layer.values()) {
      for (const stateIdx of stateIndices) {
        const st = statePool[stateIdx]!;
        const srcId = st.nodeId;
        const srcArtist = normArtists[srcId]!;

        if (isLastDepth) {
          // At the last depth, only the edge to endId matters
          const e = edgeToEnd[srcId];
          if (!e) continue;
          candidatesEvaluated++;
          if (isVisited(stateIdx, endId)) continue;

          const newMaxCost = Math.max(st.maxCost, e.cost);
          if (newMaxCost > upperBound + 1e-9) continue;

          const newTotalCost = st.totalCost + e.cost;
          const newSumSq = st.sumSquares + e.cost * e.cost;
          const endArtist = normArtists[endId]!;
          const newRepeat = st.repeatedArtistPenalty + (srcArtist === endArtist ? 0.08 : 0);

          const bucket = next.get(endId);
          if (bucket && bucket.length >= statesPerNode) {
            const worst = statePool[bucket[bucket.length - 1]!]!;
            const cmp = comparePartialScalars(
              newMaxCost, newTotalCost, newSumSq, newRepeat, st.familiarityPenalty,
              worst.maxCost, worst.totalCost, worst.sumSquares, worst.repeatedArtistPenalty, worst.familiarityPenalty,
              depth,
            );
            if (cmp >= 0) continue;
          }

          const poolIdx = statePool.length;
          statePool.push({
            nodeId: endId,
            parentIdx: stateIdx,
            maxCost: newMaxCost,
            totalCost: newTotalCost,
            sumSquares: newSumSq,
            repeatedArtistPenalty: newRepeat,
            familiarityPenalty: st.familiarityPenalty,
            edgeSimilarity: e.similarity,
            edgeConfidence: e.confidence,
            edgeProvider: e.provider,
          });
          nodesVisited.add(endId);

          if (!bucket) {
            next.set(endId, [poolIdx]);
          } else {
            bucket.push(poolIdx);
            bucket.sort((a, b) => comparePartialScalars(
              statePool[a]!.maxCost, statePool[a]!.totalCost, statePool[a]!.sumSquares, statePool[a]!.repeatedArtistPenalty, statePool[a]!.familiarityPenalty,
              statePool[b]!.maxCost, statePool[b]!.totalCost, statePool[b]!.sumSquares, statePool[b]!.repeatedArtistPenalty, statePool[b]!.familiarityPenalty,
              depth,
            ));
            if (bucket.length > statesPerNode) bucket.length = statesPerNode;
          }

          if (newMaxCost < upperBound) upperBound = newMaxCost;
          continue;
        }

        // Non-last depths: expand to all valid neighbors
        const edges = adj[srcId]!;
        for (let ei = 0; ei < edges.length; ei++) {
          const e = edges[ei]!;

          // B&B: edge costs are sorted ascending; if this edge already busts the
          // bound, all remaining edges from this source are at least as expensive.
          // Use strict > so candidates that tie the incumbent are preserved.
          const candidateMax = Math.max(st.maxCost, e.cost);
          if (candidateMax > upperBound + 1e-9) break;

          candidatesEvaluated++;
          const tgtId = e.targetId;

          if (tgtId === startId || tgtId === endId) continue;

          // Reachability: can tgtId reach endId in remaining hops?
          const hops = minHopsToEnd[tgtId]!;
          if (hops === -1 || hops > remainingAfterThis) continue;

          // Endpoint artist blocking in the middle zone
          if (checkEndpointBlock && positionInRange && endpointArtistSet!.has(normArtists[tgtId]!)) continue;

          // Duplicate check via parent-pointer walk
          if (isVisited(stateIdx, tgtId)) continue;

          const newTotalCost = st.totalCost + e.cost;
          const newSumSq = st.sumSquares + e.cost * e.cost;
          const tgtArtist = normArtists[tgtId]!;
          const newRepeat = st.repeatedArtistPenalty + (srcArtist === tgtArtist ? 0.08 : 0);

          let newFam = st.familiarityPenalty;
          if (checkFamiliarity) {
            const fam = options.familiarity!(nodeList[tgtId]!);
            if (fam != null) newFam += Math.abs(fam - familiarityDesired);
          }

          // Early rejection: skip creating state if bucket is full and this is worse
          const bucket = next.get(tgtId);
          if (bucket && bucket.length >= statesPerNode) {
            const worst = statePool[bucket[bucket.length - 1]!]!;
            const cmp = comparePartialScalars(
              candidateMax, newTotalCost, newSumSq, newRepeat, newFam,
              worst.maxCost, worst.totalCost, worst.sumSquares, worst.repeatedArtistPenalty, worst.familiarityPenalty,
              depth,
            );
            if (cmp >= 0) continue;
          }

          const poolIdx = statePool.length;
          statePool.push({
            nodeId: tgtId,
            parentIdx: stateIdx,
            maxCost: candidateMax,
            totalCost: newTotalCost,
            sumSquares: newSumSq,
            repeatedArtistPenalty: newRepeat,
            familiarityPenalty: newFam,
            edgeSimilarity: e.similarity,
            edgeConfidence: e.confidence,
            edgeProvider: e.provider,
          });
          nodesVisited.add(tgtId);

          if (!bucket) {
            next.set(tgtId, [poolIdx]);
          } else {
            bucket.push(poolIdx);
            bucket.sort((a, b) => comparePartialScalars(
              statePool[a]!.maxCost, statePool[a]!.totalCost, statePool[a]!.sumSquares, statePool[a]!.repeatedArtistPenalty, statePool[a]!.familiarityPenalty,
              statePool[b]!.maxCost, statePool[b]!.totalCost, statePool[b]!.sumSquares, statePool[b]!.repeatedArtistPenalty, statePool[b]!.familiarityPenalty,
              depth,
            ));
            if (bucket.length > statesPerNode) bucket.length = statesPerNode;
          }
        }
      }
    }
    layer = next;
    if (!layer.size) break;
  }

  // ── Reconstruct best path from parent pointers ──
  const finalBucket = layer.get(endId) ?? [];
  if (!finalBucket.length) {
    return { path: null, queryCount: 0, candidatesEvaluated, graphNodes: nodeCount, graphEdges: edgeRows.length };
  }

  function reconstructPath(poolIdx: number): { recordings: GradientRecording[]; edges: GradientRecordingPathEdge[] } {
    const chain: DPState[] = [];
    let idx = poolIdx;
    while (idx >= 0) {
      chain.push(statePool[idx]!);
      idx = statePool[idx]!.parentIdx;
    }
    chain.reverse();
    const recordings = chain.map((s) => nodeList[s.nodeId]!);
    const edges: GradientRecordingPathEdge[] = [];
    for (let i = 1; i < chain.length; i++) {
      edges.push({
        from: recordings[i - 1]!,
        to: recordings[i]!,
        similarity: chain[i]!.edgeSimilarity,
        confidence: chain[i]!.edgeConfidence,
        provider: chain[i]!.edgeProvider,
      });
    }
    return { recordings, edges };
  }

  const finals = finalBucket.map((poolIdx) => {
    const st = statePool[poolIdx]!;
    const { recordings, edges } = reconstructPath(poolIdx);
    return { state: st, recordings, edges };
  });

  const bestMax = Math.min(...finals.map((f) => f.state.maxCost));
  const eligible = finals.filter((f) => f.state.maxCost <= bestMax * 1.02 + 1e-9);
  eligible.sort((a, b) => {
    const am = spacingMetrics(a.edges);
    const bm = spacingMetrics(b.edges);
    if (Math.abs(am.maxShare - bm.maxShare) > 1e-9) return am.maxShare - bm.maxShare;
    if (Math.abs(am.imbalance - bm.imbalance) > 1e-9) return am.imbalance - bm.imbalance;
    if (Math.abs(a.state.repeatedArtistPenalty - b.state.repeatedArtistPenalty) > 1e-9) {
      return a.state.repeatedArtistPenalty - b.state.repeatedArtistPenalty;
    }
    if (Math.abs(a.state.familiarityPenalty - b.state.familiarityPenalty) > 1e-9) {
      return a.state.familiarityPenalty - b.state.familiarityPenalty;
    }
    return a.state.totalCost - b.state.totalCost;
  });

  const best = eligible[0]!;
  const result: CachedBalancedHopSearchResult = {
    path: {
      recordings: best.recordings,
      edges: best.edges,
      cost: best.state.totalCost,
      queryCount: 0,
      nodesVisited: nodesVisited.size,
      forwardFrontierSize: layer.size,
      backwardFrontierSize: 0,
      intersection: "cached_exact_hop_minimax",
    },
    queryCount: 0,
    candidatesEvaluated,
    graphNodes: nodeCount,
    graphEdges: edgeRows.length,
  };

  if (solutionCache.size >= SOLUTION_CACHE_MAX) {
    const oldest = [...solutionCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) solutionCache.delete(oldest[0]);
  }
  solutionCache.set(cacheKey, { result, graphVersion: gv, createdAt: Date.now() });

  return result;
}
