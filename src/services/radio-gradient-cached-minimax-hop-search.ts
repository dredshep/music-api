import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
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

type ValidatedEdge = {
  to: GradientRecording;
  edge: GradientRecordingPathEdge;
  cost: number;
};

type State = {
  recordings: GradientRecording[];
  edges: GradientRecordingPathEdge[];
  used: Set<string>;
  maxCost: number;
  totalCost: number;
  sumSquares: number;
  repeatedArtistPenalty: number;
  familiarityPenalty: number;
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

function partialVariance(state: State) {
  const count = Math.max(1, state.edges.length);
  const mean = state.totalCost / count;
  return Math.max(0, state.sumSquares / count - mean * mean);
}

function comparePartial(a: State, b: State) {
  if (Math.abs(a.maxCost - b.maxCost) > 1e-9) return a.maxCost - b.maxCost;
  // Once the bottleneck is tied, prefer a path whose used hops are already
  // distributed more evenly. Total cost remains a later tiebreaker rather than
  // the primary objective that previously created endpoint clusters + one cliff.
  const varianceDelta = partialVariance(a) - partialVariance(b);
  if (Math.abs(varianceDelta) > 1e-9) return varianceDelta;
  if (Math.abs(a.repeatedArtistPenalty - b.repeatedArtistPenalty) > 1e-9) {
    return a.repeatedArtistPenalty - b.repeatedArtistPenalty;
  }
  if (Math.abs(a.familiarityPenalty - b.familiarityPenalty) > 1e-9) {
    return a.familiarityPenalty - b.familiarityPenalty;
  }
  return a.totalCost - b.totalCost;
}

function addEvidence(
  adjacency: Map<string, Map<string, EdgeAggregate>>,
  from: string,
  to: string,
  evidence: Evidence,
) {
  if (from === to) return;
  let bucket = adjacency.get(from);
  if (!bucket) {
    bucket = new Map();
    adjacency.set(from, bucket);
  }
  const current = bucket.get(to);
  if (!current) {
    bucket.set(to, { best: evidence, providers: new Set([evidence.provider]) });
    return;
  }
  current.providers.add(evidence.provider);
  if (strength(evidence.similarity, evidence.confidence)
      > strength(current.best.similarity, current.best.confidence)) {
    current.best = evidence;
  }
}

/**
 * Exact-hop minimax search over the already-persisted recording graph.
 *
 * The production regression demonstrated that a 10-track smooth path already
 * exists in cache but most of its bridge edges sit below the normal top-36/48
 * neighbor window. Loading the bounded persisted graph once avoids that
 * visibility failure without issuing thousands of provider calls. Collaborative
 * evidence remains bidirectionally traversable, matching the rest of Gradient;
 * every traversed edge still receives the same cached DSP catastrophic gate and
 * confidence adjustment as the validated online provider.
 */
export function searchCachedBalancedFixedHopPath(
  start: GradientRecording,
  end: GradientRecording,
  options: CachedBalancedHopSearchOptions,
): CachedBalancedHopSearchResult {
  const requestedLength = Math.max(2, Math.floor(options.requestedLength));
  const totalEdges = requestedLength - 1;
  const minSimilarity = clamp(options.minSimilarity ?? 0.08, 0.01, 0.95);
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

  const nodes = new Map<string, GradientRecording>();
  for (const row of nodeRows) {
    nodes.set(row.canonical_key, {
      key: row.canonical_key,
      artist: row.artist,
      title: row.title,
      mbid: row.recording_mbid,
    });
  }
  // Preserve exact seed identity/MBIDs supplied by the planner.
  nodes.set(start.key, start);
  nodes.set(end.key, end);
  if (!nodes.has(start.key) || !nodes.has(end.key)) {
    return { path: null, queryCount: 0, candidatesEvaluated: 0, graphNodes: nodeRows.length, graphEdges: edgeRows.length };
  }

  const adjacency = new Map<string, Map<string, EdgeAggregate>>();
  for (const row of edgeRows) {
    if (!nodes.has(row.source_key) || !nodes.has(row.target_key)) continue;
    const evidence: Evidence = {
      provider: row.provider,
      similarity: clamp(row.similarity, 0.01, 1),
      confidence: clamp(row.confidence, 0.05, 1),
    };
    // Observed collaborative similarity is traversable adjacency in either
    // direction. Provider identity stays attached to the real evidence row.
    addEvidence(adjacency, row.source_key, row.target_key, evidence);
    addEvidence(adjacency, row.target_key, row.source_key, evidence);
  }

  const featureCache = new Map<string, CachedAcousticFeatures | null>();
  const features = (recording: GradientRecording) => {
    if (featureCache.has(recording.key)) return featureCache.get(recording.key) ?? null;
    let value: CachedAcousticFeatures | null = null;
    try {
      value = loadCachedAcousticFeatures(canonicalRadioTrackKey(recording.artist, recording.title));
    } catch {
      value = null;
    }
    featureCache.set(recording.key, value);
    return value;
  };

  const validatedCache = new Map<string, ValidatedEdge[]>();
  const validatedNeighbors = (source: GradientRecording) => {
    const cached = validatedCache.get(source.key);
    if (cached) return cached;
    const output: ValidatedEdge[] = [];
    for (const [targetKey, aggregate] of adjacency.get(source.key) ?? []) {
      const target = nodes.get(targetKey);
      if (!target) continue;
      const best = aggregate.best;
      if (best.similarity < minSimilarity) continue;

      let confidence = clamp(
        best.confidence + Math.min(0.18, Math.max(0, aggregate.providers.size - 1) * 0.09),
        0.05,
        1,
      );
      let assessment;
      try {
        assessment = assessAcousticTransition(features(source), features(target));
      } catch {
        assessment = null;
      }
      if (assessment?.catastrophic) continue;
      if (assessment && assessment.evidenceCount >= 3 && assessment.score != null) {
        if (assessment.score < 0.35) confidence *= clamp(assessment.score / 0.35, 0.35, 1);
        else if (assessment.score >= 0.72) confidence = clamp(confidence + 0.06, 0.05, 1);
      }

      const edge: GradientRecordingPathEdge = {
        from: source,
        to: target,
        similarity: best.similarity,
        confidence: clamp(confidence, 0.05, 1),
        provider: best.provider,
      };
      output.push({ to: target, edge, cost: gradientRecordingEdgeCost(edge.similarity, edge.confidence) });
    }
    output.sort((a, b) => a.cost - b.cost || a.to.key.localeCompare(b.to.key));
    validatedCache.set(source.key, output);
    return output;
  };

  let layer = new Map<string, State[]>();
  layer.set(start.key, [{
    recordings: [start],
    edges: [],
    used: new Set([start.key]),
    maxCost: 0,
    totalCost: 0,
    sumSquares: 0,
    repeatedArtistPenalty: 0,
    familiarityPenalty: 0,
  }]);
  let candidatesEvaluated = 0;
  const visitedKeys = new Set([start.key]);

  for (let depth = 1; depth <= totalEdges; depth++) {
    const next = new Map<string, State[]>();
    for (const states of layer.values()) {
      for (const state of states) {
        const source = state.recordings.at(-1)!;
        for (const candidate of validatedNeighbors(source)) {
          candidatesEvaluated++;
          const target = candidate.to;
          if (target.key === start.key || state.used.has(target.key)) continue;
          if (depth < totalEdges && target.key === end.key) continue;
          if (depth === totalEdges && target.key !== end.key) continue;
          if (depth < totalEdges && endpointArtistBlocked(target, depth, totalEdges, options.endpointArtists)) continue;

          const previousArtist = normalizedArtist(source);
          const targetArtist = normalizedArtist(target);
          const repeatedArtistPenalty = state.repeatedArtistPenalty
            + (previousArtist === targetArtist ? 0.08 : 0);
          let familiarityPenalty = state.familiarityPenalty;
          if (options.familiarity && depth < totalEdges) {
            const familiarity = options.familiarity(target);
            if (familiarity != null) {
              const position = depth / totalEdges;
              const desired = Math.pow(Math.abs(position * 2 - 1), 0.72);
              familiarityPenalty += Math.abs(familiarity - desired);
            }
          }

          const newState: State = {
            recordings: [...state.recordings, target],
            edges: [...state.edges, candidate.edge],
            used: new Set([...state.used, target.key]),
            maxCost: Math.max(state.maxCost, candidate.cost),
            totalCost: state.totalCost + candidate.cost,
            sumSquares: state.sumSquares + candidate.cost * candidate.cost,
            repeatedArtistPenalty,
            familiarityPenalty,
          };
          visitedKeys.add(target.key);
          const bucket = next.get(target.key) ?? [];
          bucket.push(newState);
          bucket.sort(comparePartial);
          if (bucket.length > statesPerNode) bucket.length = statesPerNode;
          next.set(target.key, bucket);
        }
      }
    }
    layer = next;
    if (!layer.size) break;
  }

  const finals = layer.get(end.key) ?? [];
  if (!finals.length) {
    return {
      path: null,
      queryCount: 0,
      candidatesEvaluated,
      graphNodes: nodeRows.length,
      graphEdges: edgeRows.length,
    };
  }

  // Minimax is the primary objective. Within a small (~2%) bottleneck band,
  // choose the route that distributes those edge costs most evenly rather than
  // reverting to the old total-cost preference.
  const bestMax = Math.min(...finals.map((state) => state.maxCost));
  const eligible = finals.filter((state) => state.maxCost <= bestMax * 1.02 + 1e-9);
  eligible.sort((a, b) => {
    const am = spacingMetrics(a.edges);
    const bm = spacingMetrics(b.edges);
    if (Math.abs(am.maxShare - bm.maxShare) > 1e-9) return am.maxShare - bm.maxShare;
    if (Math.abs(am.imbalance - bm.imbalance) > 1e-9) return am.imbalance - bm.imbalance;
    if (Math.abs(a.repeatedArtistPenalty - b.repeatedArtistPenalty) > 1e-9) {
      return a.repeatedArtistPenalty - b.repeatedArtistPenalty;
    }
    if (Math.abs(a.familiarityPenalty - b.familiarityPenalty) > 1e-9) {
      return a.familiarityPenalty - b.familiarityPenalty;
    }
    return a.totalCost - b.totalCost;
  });
  const best = eligible[0]!;
  return {
    path: {
      recordings: best.recordings,
      edges: best.edges,
      cost: best.totalCost,
      queryCount: 0,
      nodesVisited: visitedKeys.size,
      forwardFrontierSize: layer.size,
      backwardFrontierSize: 0,
      intersection: "cached_exact_hop_minimax",
    },
    queryCount: 0,
    candidatesEvaluated,
    graphNodes: nodeRows.length,
    graphEdges: edgeRows.length,
  };
}
