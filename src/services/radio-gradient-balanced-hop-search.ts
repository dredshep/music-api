import { normalizeForComparison } from "../domain/normalization";
import {
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingNeighbor,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "./radio-gradient-recording-path";

export type BalancedFixedHopSearchOptions = {
  requestedLength: number;
  maxQueries?: number;
  neighborLimit?: number;
  beamWidth?: number;
  minSimilarity?: number;
  endpointArtists?: [string, string] | null;
  familiarity?: (recording: GradientRecording) => number | null;
};

export type BalancedFixedHopSearchResult = {
  path: GradientRecordingPath | null;
  queryCount: number;
  candidatesEvaluated: number;
};

type PartialState = {
  recordings: GradientRecording[];
  edges: GradientRecordingPathEdge[];
  used: Set<string>;
  totalCost: number;
  maxCost: number;
  sumSquares: number;
  repeatedArtistPenalty: number;
  familiarityPenalty: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function edgeCost(similarity: number, confidence: number) {
  return gradientRecordingEdgeCost(similarity, confidence);
}

function normalizedArtist(recording: GradientRecording) {
  return normalizeForComparison(recording.artist);
}

function asRecording(row: GradientRecordingNeighbor): GradientRecording {
  return { key: row.key, artist: row.artist, title: row.title, mbid: row.mbid ?? null };
}

function asEdge(from: GradientRecording, to: GradientRecording, row: GradientRecordingNeighbor): GradientRecordingPathEdge {
  return {
    from,
    to,
    similarity: clamp(row.similarity, 0.01, 1),
    confidence: clamp(row.confidence ?? 0.8, 0.05, 1),
    provider: row.provider ?? "recording_similarity",
  };
}

function stateRank(state: PartialState) {
  const count = Math.max(1, state.edges.length);
  const mean = state.totalCost / count;
  const variance = Math.max(0, state.sumSquares / count - mean * mean);
  const spread = Math.sqrt(variance);
  // During partial search we cannot know normalized final shares yet. Keep the
  // beam biased toward low bottlenecks and low dispersion rather than merely
  // the cheapest cumulative path, which is what produced dense clusters plus
  // one giant jump in the first place.
  return state.maxCost * 1.65
    + mean * 0.35
    + spread * 0.75
    + state.repeatedArtistPenalty
    + state.familiarityPenalty * 0.18;
}

function completeMetrics(edges: GradientRecordingPathEdge[]) {
  const costs = edges.map((edge) => edgeCost(edge.similarity, edge.confidence));
  const total = Math.max(0.000001, costs.reduce((sum, value) => sum + value, 0));
  const ideal = 1 / Math.max(1, costs.length);
  const shares = costs.map((value) => value / total);
  const maxShare = shares.length ? Math.max(...shares) : 0;
  const imbalance = shares.length
    ? shares.reduce((sum, share) => sum + Math.abs(share - ideal), 0) / shares.length / ideal
    : 0;
  const maxCost = costs.length ? Math.max(...costs) : 0;
  return { total, maxShare, imbalance, maxCost };
}

function completeRank(edges: GradientRecordingPathEdge[], familiarityPenalty: number, repeatedArtistPenalty: number) {
  const metrics = completeMetrics(edges);
  // Fixed-length route quality is primarily about using the available hops
  // evenly. Total musical distance remains relevant, but cannot compensate for
  // a single transition consuming a third of the journey.
  return metrics.maxShare * 5.0
    + metrics.imbalance * 1.8
    + metrics.maxCost * 0.12
    + metrics.total * 0.015
    + familiarityPenalty * 0.10
    + repeatedArtistPenalty * 0.20;
}

function endpointArtistBlocked(
  recording: GradientRecording,
  absoluteDepth: number,
  totalEdges: number,
  endpoints: [string, string] | null | undefined,
) {
  if (!endpoints || totalEdges <= 1) return false;
  const position = absoluteDepth / totalEdges;
  if (position < 0.22 || position > 0.78) return false;
  const artist = normalizedArtist(recording);
  return endpoints.map((value) => normalizeForComparison(value)).includes(artist);
}

function extendState(
  state: PartialState,
  row: GradientRecordingNeighbor,
  reverse: boolean,
  absoluteDepth: number,
  totalEdges: number,
  options: BalancedFixedHopSearchOptions,
): PartialState | null {
  if (row.similarity < (options.minSimilarity ?? 0.08)) return null;
  if (state.used.has(row.key)) return null;
  const next = asRecording(row);
  if (endpointArtistBlocked(next, absoluteDepth, totalEdges, options.endpointArtists)) return null;

  const current = state.recordings.at(-1)!;
  const edge = reverse ? asEdge(next, current, row) : asEdge(current, next, row);
  const cost = edgeCost(edge.similarity, edge.confidence);
  const previousArtist = normalizedArtist(current);
  const nextArtist = normalizedArtist(next);
  const repeatedArtistPenalty = state.repeatedArtistPenalty + (previousArtist === nextArtist ? 0.08 : 0);

  let familiarityPenalty = state.familiarityPenalty;
  if (options.familiarity) {
    const familiarity = options.familiarity(next);
    if (familiarity != null) {
      const position = absoluteDepth / Math.max(1, totalEdges);
      const target = Math.pow(Math.abs(position * 2 - 1), 0.72);
      familiarityPenalty += Math.abs(familiarity - target);
    }
  }

  return {
    recordings: [...state.recordings, next],
    edges: [...state.edges, edge],
    used: new Set([...state.used, next.key]),
    totalCost: state.totalCost + cost,
    maxCost: Math.max(state.maxCost, cost),
    sumSquares: state.sumSquares + cost * cost,
    repeatedArtistPenalty,
    familiarityPenalty,
  };
}

async function buildLayeredBeam(input: {
  start: GradientRecording;
  depth: number;
  totalEdges: number;
  reverse: boolean;
  provider: GradientRecordingNeighborProvider;
  options: BalancedFixedHopSearchOptions;
  queryBudget: number;
}) {
  const neighborLimit = Math.max(8, Math.min(64, input.options.neighborLimit ?? 48));
  const beamWidth = Math.max(4, Math.min(32, input.options.beamWidth ?? 18));
  const expandWidth = Math.max(3, Math.min(8, Math.ceil(beamWidth / 3)));
  let queryCount = 0;
  let states: PartialState[] = [{
    recordings: [input.start],
    edges: [],
    used: new Set([input.start.key]),
    totalCost: 0,
    maxCost: 0,
    sumSquares: 0,
    repeatedArtistPenalty: 0,
    familiarityPenalty: 0,
  }];

  for (let layer = 0; layer < input.depth; layer++) {
    if (!states.length || queryCount >= input.queryBudget) break;
    const expandable = [...states]
      .sort((a, b) => stateRank(a) - stateRank(b))
      .slice(0, Math.min(expandWidth, input.queryBudget - queryCount));
    const expanded = await Promise.all(expandable.map(async (state) => {
      const recording = state.recordings.at(-1)!;
      try {
        const rows = await input.provider.neighbors(recording, neighborLimit);
        return { state, rows };
      } catch {
        return { state, rows: [] as GradientRecordingNeighbor[] };
      }
    }));
    queryCount += expandable.length;

    const next: PartialState[] = [];
    const absoluteDepth = input.reverse
      ? input.totalEdges - (layer + 1)
      : layer + 1;
    for (const { state, rows } of expanded) {
      for (const row of rows) {
        const candidate = extendState(
          state, row, input.reverse, absoluteDepth, input.totalEdges, input.options,
        );
        if (candidate) next.push(candidate);
      }
    }

    // Keep multiple paths to the same last recording when their used-node sets
    // differ, but cap duplicates so one popular hub cannot consume the beam.
    const perLast = new Map<string, number>();
    states = next
      .sort((a, b) => stateRank(a) - stateRank(b))
      .filter((state) => {
        const key = state.recordings.at(-1)!.key;
        const count = perLast.get(key) ?? 0;
        if (count >= 2) return false;
        perLast.set(key, count + 1);
        return true;
      })
      .slice(0, beamWidth);
  }

  return { states: states.filter((state) => state.edges.length === input.depth), queryCount };
}

function reverseBackwardState(state: PartialState) {
  const recordings = [...state.recordings].reverse();
  const edges = [...state.edges].reverse();
  return { recordings, edges };
}

/**
 * Search the recording graph for exactly N tracks, rather than first finding a
 * cheapest arbitrary-length path and trying to massage it afterward. The path
 * is built as two bounded beams joined by one validated point edge, which keeps
 * provider work bounded while making the requested hop count a first-class
 * constraint.
 */
export async function searchBalancedFixedHopPath(
  start: GradientRecording,
  end: GradientRecording,
  provider: GradientRecordingNeighborProvider,
  options: BalancedFixedHopSearchOptions,
): Promise<BalancedFixedHopSearchResult> {
  const requestedLength = Math.max(2, Math.floor(options.requestedLength));
  const totalEdges = requestedLength - 1;
  const maxQueries = Math.max(2, options.maxQueries ?? 48);
  if (!provider.lookupEdge) return { path: null, queryCount: 0, candidatesEvaluated: 0 };

  const leftDepth = Math.floor((totalEdges - 1) / 2);
  const rightDepth = totalEdges - 1 - leftDepth;
  const leftBudget = Math.max(1, Math.floor(maxQueries / 2));
  const rightBudget = Math.max(1, maxQueries - leftBudget);

  const [left, right] = await Promise.all([
    buildLayeredBeam({
      start,
      depth: leftDepth,
      totalEdges,
      reverse: false,
      provider,
      options,
      queryBudget: leftBudget,
    }),
    buildLayeredBeam({
      start: end,
      depth: rightDepth,
      totalEdges,
      reverse: true,
      provider,
      options,
      queryBudget: rightBudget,
    }),
  ]);

  let best: { path: GradientRecordingPath; rank: number } | null = null;
  let candidatesEvaluated = 0;
  for (const leftState of left.states) {
    const leftLast = leftState.recordings.at(-1)!;
    for (const rightState of right.states) {
      const rightLast = rightState.recordings.at(-1)!;
      if (leftLast.key === rightLast.key) continue;
      const overlap = [...leftState.used].some((key) => rightState.used.has(key));
      if (overlap) continue;

      const join = provider.lookupEdge(leftLast.key, rightLast.key);
      if (!join || join.similarity < (options.minSimilarity ?? 0.08)) continue;
      candidatesEvaluated++;
      const joinEdge = asEdge(leftLast, rightLast, join);
      const backward = reverseBackwardState(rightState);
      const recordings = [...leftState.recordings, ...backward.recordings];
      if (recordings.length !== requestedLength) continue;
      const keys = new Set(recordings.map((recording) => recording.key));
      if (keys.size !== recordings.length) continue;
      const edges = [...leftState.edges, joinEdge, ...backward.edges];
      if (edges.length !== totalEdges) continue;

      const repeatedArtistPenalty = leftState.repeatedArtistPenalty + rightState.repeatedArtistPenalty
        + (normalizedArtist(leftLast) === normalizedArtist(rightLast) ? 0.08 : 0);
      const familiarityPenalty = leftState.familiarityPenalty + rightState.familiarityPenalty;
      const rank = completeRank(edges, familiarityPenalty, repeatedArtistPenalty);
      const path: GradientRecordingPath = {
        recordings,
        edges,
        cost: edges.reduce((sum, edge) => sum + edgeCost(edge.similarity, edge.confidence), 0),
        queryCount: left.queryCount + right.queryCount,
        nodesVisited: left.states.length + right.states.length,
        forwardFrontierSize: left.states.length,
        backwardFrontierSize: right.states.length,
        intersection: `${leftLast.key}=>${rightLast.key}`,
      };
      if (!best || rank < best.rank) best = { path, rank };
    }
  }

  return {
    path: best?.path ?? null,
    queryCount: left.queryCount + right.queryCount,
    candidatesEvaluated,
  };
}
