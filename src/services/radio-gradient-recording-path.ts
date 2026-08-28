import { normalizeForComparison } from "../domain/normalization";
import type { GradientRouteBudget } from "./radio-gradient-budget";

export interface GradientRecording {
  key: string;
  artist: string;
  title: string;
  mbid: string | null;
}

export interface GradientRecordingNeighbor extends GradientRecording {
  similarity: number;
  confidence?: number;
  provider?: string;
}

export interface GradientRecordingNeighborProvider {
  neighbors(recording: GradientRecording, limit: number): Promise<GradientRecordingNeighbor[]>;
}

export interface GradientRecordingPathEdge {
  from: GradientRecording;
  to: GradientRecording;
  similarity: number;
  confidence: number;
  provider: string;
}

export interface GradientRecordingPath {
  recordings: GradientRecording[];
  edges: GradientRecordingPathEdge[];
  cost: number;
  queryCount: number;
  nodesVisited: number;
  forwardFrontierSize: number;
  backwardFrontierSize: number;
  intersection: string | null;
}

export interface PositionedGradientRecording extends GradientRecording {
  routePosition: number;
  routeConfidence: number;
}

export interface GradientDensificationOperation {
  gapIndex: number;
  left: string;
  inserted: string;
  right: string;
  leftSimilarity: number;
  rightSimilarity: number;
  bottleneck: number;
  familiarityTarget: number;
  familiarityActual: number | null;
}

export interface GradientDensificationResult {
  path: GradientRecordingPath;
  positioned: PositionedGradientRecording[];
  operations: GradientDensificationOperation[];
  queryCount: number;
  stoppedReason: "requested_length" | "no_bridge" | "query_budget";
}

export interface GradientRecordingSearchResult {
  path: GradientRecordingPath | null;
  queryCount: number;
  nodesVisited: number;
}

export interface GradientPathSearchOptions {
  maxQueries?: number;
  maxNodes?: number;
  beamPerSide?: number;
  frontierCap?: number;
  neighborLimit?: number;
  refineQueries?: number;
}

export interface GradientDensifyOptions {
  maxQueries?: number;
  neighborLimit?: number;
  minBridgeSimilarity?: number;
  endpointArtists?: [string, string] | null;
  familiarity?: (recording: GradientRecording) => number | null;
  familiarityWeight?: number;
}

type GraphEdge = {
  to: string;
  similarity: number;
  confidence: number;
  provider: string;
};

type Graph = {
  nodes: Map<string, GradientRecording>;
  edges: Map<string, Map<string, GraphEdge>>;
};

type FrontierState = { key: string; cost: number; depth: number };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function gradientRecordingKey(artist: string, title: string) {
  return `${normalizeForComparison(artist)}|${normalizeForComparison(title)}`;
}

export function gradientRecording(artist: string, title: string, mbid?: string | null): GradientRecording {
  return {
    key: gradientRecordingKey(artist, title),
    artist: artist.trim(),
    title: title.trim(),
    mbid: mbid?.trim() || null,
  };
}

function normalizeRecording(recording: Omit<GradientRecording, "key"> & { key?: string }): GradientRecording | null {
  const artist = recording.artist.trim();
  const title = recording.title.trim();
  if (!artist || !title) return null;
  return {
    key: recording.key || gradientRecordingKey(artist, title),
    artist,
    title,
    mbid: recording.mbid?.trim() || null,
  };
}

function newGraph(): Graph {
  return { nodes: new Map(), edges: new Map() };
}

function remember(graph: Graph, recording: GradientRecording) {
  const current = graph.nodes.get(recording.key);
  if (!current || (!current.mbid && recording.mbid)) graph.nodes.set(recording.key, recording);
  if (!graph.edges.has(recording.key)) graph.edges.set(recording.key, new Map());
}

function edgeStrength(similarity: number, confidence: number) {
  return clamp(similarity, 0.01, 1) * clamp(confidence, 0.05, 1);
}

export function gradientRecordingEdgeCost(similarity: number, confidence = 1) {
  return -Math.log(clamp(edgeStrength(similarity, confidence), 0.015, 1)) + 0.025;
}

function addEdge(
  graph: Graph,
  from: GradientRecording,
  to: GradientRecording,
  similarity: number,
  confidence: number,
  provider: string,
) {
  if (from.key === to.key) return;
  remember(graph, from);
  remember(graph, to);
  const score = clamp(similarity, 0.01, 1);
  const edgeConfidence = clamp(confidence, 0.05, 1);
  const addOne = (a: string, b: string) => {
    const bucket = graph.edges.get(a)!;
    const current = bucket.get(b);
    if (!current || edgeStrength(score, edgeConfidence) > edgeStrength(current.similarity, current.confidence)) {
      bucket.set(b, { to: b, similarity: score, confidence: edgeConfidence, provider });
    }
  };
  // Collaborative recording similarity is not guaranteed to be reciprocal.
  // Search treats observed similarity as traversable adjacency, while provider
  // and confidence remain attached so later validation can distinguish evidence.
  addOne(from.key, to.key);
  addOne(to.key, from.key);
}

function graphPath(graph: Graph, keys: string[], queryCount: number, diagnostics: Omit<GradientRecordingPath, "recordings" | "edges" | "cost" | "queryCount">): GradientRecordingPath | null {
  const recordings = keys.map((key) => graph.nodes.get(key)).filter((row): row is GradientRecording => Boolean(row));
  if (recordings.length !== keys.length) return null;
  const edges: GradientRecordingPathEdge[] = [];
  let cost = 0;
  for (let index = 1; index < keys.length; index++) {
    const from = recordings[index - 1]!;
    const to = recordings[index]!;
    const edge = graph.edges.get(from.key)?.get(to.key);
    if (!edge) return null;
    cost += gradientRecordingEdgeCost(edge.similarity, edge.confidence);
    edges.push({ from, to, similarity: edge.similarity, confidence: edge.confidence, provider: edge.provider });
  }
  return { recordings, edges, cost, queryCount, ...diagnostics };
}

function dedupeFrontier(frontier: FrontierState[], distances: Map<string, number>, cap: number) {
  const best = new Map<string, FrontierState>();
  for (const state of frontier) {
    if (Math.abs((distances.get(state.key) ?? Infinity) - state.cost) > 1e-9) continue;
    const current = best.get(state.key);
    if (!current || state.cost < current.cost) best.set(state.key, state);
  }
  const sorted = [...best.values()].sort((a, b) => a.cost - b.cost || a.depth - b.depth || a.key.localeCompare(b.key));
  if (sorted.length <= cap) return sorted;

  // Preserve depth diversity so deeper frontier nodes aren't lost to cheaper
  // shallow entries. Reserve slots per depth level before filling the rest.
  const byDepth = new Map<number, FrontierState[]>();
  for (const s of sorted) {
    const bucket = byDepth.get(s.depth);
    if (bucket) bucket.push(s); else byDepth.set(s.depth, [s]);
  }
  const depthCount = byDepth.size;
  const perDepth = Math.max(4, Math.floor(cap / Math.max(1, depthCount * 2)));
  const selected = new Set<string>();
  const result: FrontierState[] = [];
  for (const [, bucket] of byDepth) {
    for (const s of bucket.slice(0, perDepth)) {
      if (!selected.has(s.key)) { selected.add(s.key); result.push(s); }
    }
  }
  for (const s of sorted) {
    if (result.length >= cap) break;
    if (!selected.has(s.key)) { selected.add(s.key); result.push(s); }
  }
  return result.sort((a, b) => a.cost - b.cost || a.depth - b.depth || a.key.localeCompare(b.key));
}

function bestIntersection(forward: Map<string, number>, backward: Map<string, number>) {
  let key: string | null = null;
  let cost = Infinity;
  for (const [candidate, left] of forward) {
    const right = backward.get(candidate);
    if (right == null) continue;
    const total = left + right;
    if (total < cost) {
      key = candidate;
      cost = total;
    }
  }
  return key ? { key, cost } : null;
}

function reconstructKeys(
  meeting: string,
  forwardParent: Map<string, string>,
  backwardParent: Map<string, string>,
) {
  const left = [meeting];
  while (forwardParent.has(left[0]!)) left.unshift(forwardParent.get(left[0]!)!);
  const right: string[] = [];
  let cursor = meeting;
  while (backwardParent.has(cursor)) {
    cursor = backwardParent.get(cursor)!;
    right.push(cursor);
  }
  return [...left, ...right];
}

function keyArtist(key: string) {
  const sep = key.indexOf("|");
  return sep > 0 ? key.slice(0, sep) : key;
}

async function expandSide(input: {
  graph: Graph;
  frontier: FrontierState[];
  distances: Map<string, number>;
  parents: Map<string, string>;
  expanded: Set<string>;
  provider: GradientRecordingNeighborProvider;
  beam: number;
  frontierCap: number;
  neighborLimit: number;
  maxNodes: number;
  remainingQueries: number;
  seedArtists?: Set<string>;
  depthFirst?: boolean;
}) {
  const seedArtists = input.seedArtists;
  const depthFirst = input.depthFirst ?? false;
  const batch = input.frontier
    .filter((state) => !input.expanded.has(state.key))
    .sort((a, b) => {
      // Recordings by seed endpoint artists share nearly identical neighbor
      // sets. Expanding them first wastes the query budget in a comfort zone
      // rather than bridging toward the other endpoint. Prefer non-seed-artist
      // nodes so the search branches outward sooner.
      if (seedArtists) {
        const aIsSeed = seedArtists.has(keyArtist(a.key)) ? 1 : 0;
        const bIsSeed = seedArtists.has(keyArtist(b.key)) ? 1 : 0;
        if (aIsSeed !== bIsSeed) return aIsSeed - bIsSeed;
      }
      // When no intersection has been found after the initial budget,
      // prioritize depth over cost so the search reaches further into
      // intermediate genre territory.
      if (depthFirst) return b.depth - a.depth || a.cost - b.cost;
      return a.cost - b.cost || a.depth - b.depth;
    })
    .slice(0, Math.min(input.beam, input.remainingQueries));
  batch.forEach((state) => input.expanded.add(state.key));
  const rows = await Promise.all(batch.map(async (state) => {
    const recording = input.graph.nodes.get(state.key)!;
    try {
      return { state, neighbors: await input.provider.neighbors(recording, input.neighborLimit) };
    } catch {
      return { state, neighbors: [] as GradientRecordingNeighbor[] };
    }
  }));

  const next = input.frontier.filter((state) => !input.expanded.has(state.key));
  for (const { state, neighbors } of rows) {
    const source = input.graph.nodes.get(state.key)!;
    for (const raw of neighbors) {
      const target = normalizeRecording(raw);
      if (!target || target.key === source.key) continue;
      if (!input.graph.nodes.has(target.key) && input.graph.nodes.size >= input.maxNodes) continue;
      const similarity = clamp(raw.similarity, 0.01, 1);
      const confidence = clamp(raw.confidence ?? 0.8, 0.05, 1);
      addEdge(input.graph, source, target, similarity, confidence, raw.provider ?? "recording_similarity");
      const candidateCost = state.cost + gradientRecordingEdgeCost(similarity, confidence);
      if (candidateCost + 1e-9 < (input.distances.get(target.key) ?? Infinity)) {
        input.distances.set(target.key, candidateCost);
        input.parents.set(target.key, source.key);
        next.push({ key: target.key, cost: candidateCost, depth: state.depth + 1 });
      }
    }
  }
  return {
    frontier: dedupeFrontier(next, input.distances, input.frontierCap),
    queries: batch.length,
  };
}

/**
 * Bounded multi-source bidirectional search over playable recordings. This is
 * deliberately not greedy: both endpoint regions expand until their discovered
 * graphs intersect, then search refines briefly for a lower-bottleneck path.
 */
export async function discoverGradientRecordingPath(
  startCandidates: GradientRecording[],
  endCandidates: GradientRecording[],
  provider: GradientRecordingNeighborProvider,
  options: GradientPathSearchOptions = {},
): Promise<GradientRecordingPath | null> {
  const maxQueries = Math.max(1, options.maxQueries ?? 64);
  const maxNodes = Math.max(16, options.maxNodes ?? 1200);
  const beam = Math.max(1, options.beamPerSide ?? 4);
  const frontierCap = Math.max(beam * 2, options.frontierCap ?? 120);
  const neighborLimit = Math.max(4, options.neighborLimit ?? 36);
  const refineQueries = Math.max(0, options.refineQueries ?? 10);
  const graph = newGraph();
  const starts = startCandidates.map(normalizeRecording).filter((row): row is GradientRecording => Boolean(row));
  const ends = endCandidates.map(normalizeRecording).filter((row): row is GradientRecording => Boolean(row));
  for (const row of [...starts, ...ends]) remember(graph, row);
  if (!starts.length || !ends.length) return null;

  const endKeys = new Set(ends.map((row) => row.key));
  const overlap = starts.find((row) => endKeys.has(row.key));
  if (overlap) {
    return {
      recordings: [overlap], edges: [], cost: 0, queryCount: 0, nodesVisited: graph.nodes.size,
      forwardFrontierSize: starts.length, backwardFrontierSize: ends.length, intersection: overlap.key,
    };
  }

  const forwardSeedArtists = new Set(starts.map((row) => keyArtist(row.key)));
  const backwardSeedArtists = new Set(ends.map((row) => keyArtist(row.key)));

  const forwardDistances = new Map(starts.map((row) => [row.key, 0]));
  const backwardDistances = new Map(ends.map((row) => [row.key, 0]));
  const forwardParent = new Map<string, string>();
  const backwardParent = new Map<string, string>();
  const forwardExpanded = new Set<string>();
  const backwardExpanded = new Set<string>();
  let forwardFrontier = starts.map((row) => ({ key: row.key, cost: 0, depth: 0 }));
  let backwardFrontier = ends.map((row) => ({ key: row.key, cost: 0, depth: 0 }));
  let queryCount = 0;
  let foundAt: number | null = null;
  let best: { key: string; cost: number } | null = null;

  // Initial cost-first phase uses part of the budget. If no intersection is
  // found, a second depth-first phase spends the remaining budget reaching
  // further into intermediate genre territory — critical for very distant
  // endpoint pairs (e.g. Poppy → Taake) where the similarity graphs are
  // disjoint at shallow depths.
  const initialBudget = Math.ceil(maxQueries * 0.45);

  while (queryCount < maxQueries && (forwardFrontier.length || backwardFrontier.length)) {
    const remaining = maxQueries - queryCount;
    const leftBudget = Math.min(beam, Math.max(0, Math.ceil(remaining / 2)));
    const rightBudget = Math.min(beam, Math.max(0, remaining - leftBudget));
    const useDepthFirst = !best && queryCount >= initialBudget;
    const [left, right] = await Promise.all([
      expandSide({
        graph, frontier: forwardFrontier, distances: forwardDistances, parents: forwardParent,
        expanded: forwardExpanded, provider, beam: leftBudget, frontierCap, neighborLimit, maxNodes,
        remainingQueries: leftBudget, seedArtists: forwardSeedArtists, depthFirst: useDepthFirst,
      }),
      expandSide({
        graph, frontier: backwardFrontier, distances: backwardDistances, parents: backwardParent,
        expanded: backwardExpanded, provider, beam: rightBudget, frontierCap, neighborLimit, maxNodes,
        remainingQueries: rightBudget, seedArtists: backwardSeedArtists, depthFirst: useDepthFirst,
      }),
    ]);
    forwardFrontier = left.frontier;
    backwardFrontier = right.frontier;
    queryCount += left.queries + right.queries;

    const intersection = bestIntersection(forwardDistances, backwardDistances);
    if (intersection && (!best || intersection.cost < best.cost)) best = intersection;
    if (intersection && foundAt == null) foundAt = queryCount;
    if (foundAt != null && queryCount >= foundAt + refineQueries) break;
    if (!left.queries && !right.queries) break;
  }

  if (!best) return null;
  const keys = reconstructKeys(best.key, forwardParent, backwardParent);
  return graphPath(graph, keys, queryCount, {
    nodesVisited: graph.nodes.size,
    forwardFrontierSize: forwardFrontier.length,
    backwardFrontierSize: backwardFrontier.length,
    intersection: best.key,
  });
}

/**
 * Same as discoverGradientRecordingPath but always returns a structured result
 * with the consumed budget, even when no path is found.
 */
export async function searchGradientRecordingPath(
  startCandidates: GradientRecording[],
  endCandidates: GradientRecording[],
  provider: GradientRecordingNeighborProvider,
  options: GradientPathSearchOptions = {},
): Promise<GradientRecordingSearchResult> {
  const maxQueries = Math.max(1, options.maxQueries ?? 64);
  const maxNodes = Math.max(16, options.maxNodes ?? 1200);
  const beam = Math.max(1, options.beamPerSide ?? 4);
  const frontierCap = Math.max(beam * 2, options.frontierCap ?? 120);
  const neighborLimit = Math.max(4, options.neighborLimit ?? 36);
  const refineQueries = Math.max(0, options.refineQueries ?? 10);
  const graph = newGraph();
  const starts = startCandidates.map(normalizeRecording).filter((row): row is GradientRecording => Boolean(row));
  const ends = endCandidates.map(normalizeRecording).filter((row): row is GradientRecording => Boolean(row));
  for (const row of [...starts, ...ends]) remember(graph, row);
  if (!starts.length || !ends.length) return { path: null, queryCount: 0, nodesVisited: graph.nodes.size };

  const endKeys = new Set(ends.map((row) => row.key));
  const overlap = starts.find((row) => endKeys.has(row.key));
  if (overlap) {
    const path: GradientRecordingPath = {
      recordings: [overlap], edges: [], cost: 0, queryCount: 0, nodesVisited: graph.nodes.size,
      forwardFrontierSize: starts.length, backwardFrontierSize: ends.length, intersection: overlap.key,
    };
    return { path, queryCount: 0, nodesVisited: graph.nodes.size };
  }

  const forwardSeedArtists = new Set(starts.map((row) => keyArtist(row.key)));
  const backwardSeedArtists = new Set(ends.map((row) => keyArtist(row.key)));
  const forwardDistances = new Map(starts.map((row) => [row.key, 0]));
  const backwardDistances = new Map(ends.map((row) => [row.key, 0]));
  const forwardParent = new Map<string, string>();
  const backwardParent = new Map<string, string>();
  const forwardExpanded = new Set<string>();
  const backwardExpanded = new Set<string>();
  let forwardFrontier = starts.map((row) => ({ key: row.key, cost: 0, depth: 0 }));
  let backwardFrontier = ends.map((row) => ({ key: row.key, cost: 0, depth: 0 }));
  let queryCount = 0;
  let foundAt: number | null = null;
  let best: { key: string; cost: number } | null = null;
  const initialBudget = Math.ceil(maxQueries * 0.45);

  while (queryCount < maxQueries && (forwardFrontier.length || backwardFrontier.length)) {
    const remaining = maxQueries - queryCount;
    const leftBudget = Math.min(beam, Math.max(0, Math.ceil(remaining / 2)));
    const rightBudget = Math.min(beam, Math.max(0, remaining - leftBudget));
    const useDepthFirst = !best && queryCount >= initialBudget;
    const [left, right] = await Promise.all([
      expandSide({
        graph, frontier: forwardFrontier, distances: forwardDistances, parents: forwardParent,
        expanded: forwardExpanded, provider, beam: leftBudget, frontierCap, neighborLimit, maxNodes,
        remainingQueries: leftBudget, seedArtists: forwardSeedArtists, depthFirst: useDepthFirst,
      }),
      expandSide({
        graph, frontier: backwardFrontier, distances: backwardDistances, parents: backwardParent,
        expanded: backwardExpanded, provider, beam: rightBudget, frontierCap, neighborLimit, maxNodes,
        remainingQueries: rightBudget, seedArtists: backwardSeedArtists, depthFirst: useDepthFirst,
      }),
    ]);
    forwardFrontier = left.frontier;
    backwardFrontier = right.frontier;
    queryCount += left.queries + right.queries;

    const intersection = bestIntersection(forwardDistances, backwardDistances);
    if (intersection && (!best || intersection.cost < best.cost)) best = intersection;
    if (intersection && foundAt == null) foundAt = queryCount;
    if (foundAt != null && queryCount >= foundAt + refineQueries) break;
    if (!left.queries && !right.queries) break;
  }

  if (!best) return { path: null, queryCount, nodesVisited: graph.nodes.size };
  const keys = reconstructKeys(best.key, forwardParent, backwardParent);
  const path = graphPath(graph, keys, queryCount, {
    nodesVisited: graph.nodes.size,
    forwardFrontierSize: forwardFrontier.length,
    backwardFrontierSize: backwardFrontier.length,
    intersection: best.key,
  });
  return { path, queryCount, nodesVisited: graph.nodes.size };
}

function harmonicMean(a: number, b: number) {
  return (2 * a * b) / Math.max(0.000001, a + b);
}

export function gradientFamiliarityTarget(position: number) {
  const t = clamp(position, 0, 1);
  // U-shaped target: familiar at both ends, deliberately novel in the middle.
  return Math.pow(Math.abs(t * 2 - 1), 0.72);
}

export function positionGradientRecordingPath(path: GradientRecordingPath): PositionedGradientRecording[] {
  if (!path.recordings.length) return [];
  if (path.recordings.length === 1) return [{ ...path.recordings[0]!, routePosition: 0, routeConfidence: 1 }];
  const distances = path.edges.map((edge) => gradientRecordingEdgeCost(edge.similarity, edge.confidence));
  const total = Math.max(0.000001, distances.reduce((sum, value) => sum + value, 0));
  let cursor = 0;
  return path.recordings.map((recording, index) => {
    if (index > 0) cursor += distances[index - 1]!;
    const previous = path.edges[index - 1];
    const next = path.edges[index];
    const routeConfidence = index === 0 || index === path.recordings.length - 1
      ? 1
      : Math.sqrt((previous?.similarity ?? 0.05) * (next?.similarity ?? 0.05));
    return {
      ...recording,
      routePosition: index === path.recordings.length - 1 ? 1 : cursor / total,
      routeConfidence: clamp(routeConfidence, 0.05, 1),
    };
  });
}

export interface GradientNoveltyRefinementResult {
  path: GradientRecordingPath;
  replacements: number;
  queryCount: number;
}

/**
 * Post-path novelty refinement: replaces overfamiliar interior recordings in
 * the central portion of the path when both neighboring transitions remain
 * valid. Never touches endpoints or mandatory waypoints.
 */
export async function refinePathNovelty(
  original: GradientRecordingPath,
  provider: GradientRecordingNeighborProvider,
  options: {
    familiarity: (recording: GradientRecording) => number | null;
    maxQueries?: number;
    neighborLimit?: number;
    mandatoryKeys?: Set<string>;
    endpointArtists?: [string, string] | null;
    minTransitionSimilarity?: number;
  },
): Promise<GradientNoveltyRefinementResult> {
  const maxQueries = Math.max(0, options.maxQueries ?? 24);
  const neighborLimit = Math.max(4, options.neighborLimit ?? 36);
  const minSim = clamp(options.minTransitionSimilarity ?? 0.12, 0.01, 0.95);
  const mandatory = options.mandatoryKeys ?? new Set<string>();
  const endpointArtists = new Set(
    (options.endpointArtists ?? []).filter(Boolean).map((a) => normalizeForComparison(a)),
  );

  if (original.recordings.length < 4) return { path: original, replacements: 0, queryCount: 0 };

  const recordings = [...original.recordings];
  const edges = [...original.edges];
  mandatory.add(recordings[0]!.key);
  mandatory.add(recordings.at(-1)!.key);

  const usedKeys = new Set(recordings.map((r) => r.key));
  const neighborCache = new Map<string, Promise<GradientRecordingNeighbor[]>>();
  let queryCount = 0;

  const fetchNeighbors = async (recording: GradientRecording) => {
    const existing = neighborCache.get(recording.key);
    if (existing) return existing;
    if (queryCount >= maxQueries) return [];
    queryCount++;
    const promise = provider.neighbors(recording, neighborLimit).catch(() => [] as GradientRecordingNeighbor[]);
    neighborCache.set(recording.key, promise);
    return promise;
  };

  let replacements = 0;
  const len = recordings.length;

  for (let i = 1; i < len - 1; i++) {
    if (queryCount >= maxQueries) break;
    const position = i / (len - 1);
    if (position < 0.2 || position > 0.8) continue;
    const rec = recordings[i]!;
    if (mandatory.has(rec.key)) continue;

    const currentFamiliarity = options.familiarity(rec);
    if (currentFamiliarity == null) continue;
    const target = gradientFamiliarityTarget(position);
    if (currentFamiliarity <= target + 0.15) continue;

    const prev = recordings[i - 1]!;
    const next = recordings[i + 1]!;
    const [leftNeighbors, rightNeighbors] = await Promise.all([
      fetchNeighbors(prev),
      fetchNeighbors(next),
    ]);

    const rightMap = new Map(rightNeighbors.map((n) => [gradientRecordingKey(n.artist, n.title), n]));

    let best: {
      recording: GradientRecording;
      leftEdge: GradientRecordingNeighbor;
      rightEdge: GradientRecordingNeighbor;
      score: number;
    } | null = null;

    for (const leftCandidate of leftNeighbors) {
      const key = gradientRecordingKey(leftCandidate.artist, leftCandidate.title);
      if (key === rec.key || key === prev.key || key === next.key) continue;
      if (usedKeys.has(key)) continue;
      const rightCandidate = rightMap.get(key);
      if (!rightCandidate) continue;
      if (leftCandidate.similarity < minSim || rightCandidate.similarity < minSim) continue;

      const candidateRec = gradientRecording(leftCandidate.artist, leftCandidate.title, leftCandidate.mbid);
      const candidateFamiliarity = options.familiarity(candidateRec);
      const familiarityImprovement = candidateFamiliarity != null
        ? (currentFamiliarity - target) - Math.max(0, candidateFamiliarity - target)
        : (currentFamiliarity - target) * 0.5;
      if (familiarityImprovement <= 0.05) continue;

      const bridge = harmonicMean(
        clamp(leftCandidate.similarity, 0, 1),
        clamp(rightCandidate.similarity, 0, 1),
      );
      const currentBridge = harmonicMean(
        clamp(edges[i - 1]!.similarity, 0, 1),
        clamp(edges[i]!.similarity, 0, 1),
      );
      if (bridge < currentBridge * 0.65) continue;

      const artistNorm = normalizeForComparison(leftCandidate.artist);
      const endpointPenalty = endpointArtists.has(artistNorm) ? 0.15 : 0;
      const score = familiarityImprovement * 0.55 + bridge * 0.35 - endpointPenalty;
      if (!best || score > best.score) {
        best = { recording: candidateRec, leftEdge: leftCandidate, rightEdge: rightCandidate, score };
      }
    }

    if (best) {
      usedKeys.delete(rec.key);
      usedKeys.add(best.recording.key);
      recordings[i] = best.recording;
      edges[i - 1] = {
        from: prev, to: best.recording,
        similarity: best.leftEdge.similarity,
        confidence: best.leftEdge.confidence ?? 0.8,
        provider: best.leftEdge.provider ?? "recording_similarity",
      };
      edges[i] = {
        from: best.recording, to: next,
        similarity: best.rightEdge.similarity,
        confidence: best.rightEdge.confidence ?? 0.8,
        provider: best.rightEdge.provider ?? "recording_similarity",
      };
      replacements++;
    }
  }

  const cost = edges.reduce((sum, e) => sum + gradientRecordingEdgeCost(e.similarity, e.confidence), 0);
  return {
    path: { ...original, recordings, edges, cost },
    replacements,
    queryCount,
  };
}

export interface GradientPathCompressionResult {
  path: GradientRecordingPath;
  removedCount: number;
  compressed: boolean;
  partialReason: string | null;
}

/**
 * Safely compress a path to the requested length by removing interior nodes
 * only when the previous and next retained recordings have a real validated
 * edge from the provider. Endpoints and waypoints are never removed.
 */
export async function compressGradientRecordingPath(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  mandatoryKeys?: Set<string>,
  budget?: GradientRouteBudget,
): Promise<GradientPathCompressionResult> {
  if (original.recordings.length <= requestedLength) {
    return { path: original, removedCount: 0, compressed: true, partialReason: null };
  }
  const recordings = [...original.recordings];
  const edges = [...original.edges];
  const mandatory = mandatoryKeys ?? new Set<string>();
  mandatory.add(recordings[0]!.key);
  mandatory.add(recordings.at(-1)!.key);
  let removedCount = 0;

  const neighborCache = new Map<string, GradientRecordingNeighbor[]>();
  const fetchNeighbors = async (rec: GradientRecording) => {
    const cached = neighborCache.get(rec.key);
    if (cached) return cached;
    if (budget) budget.compressionQueries += 1;
    const result = await provider.neighbors(rec, 48).catch(() => [] as GradientRecordingNeighbor[]);
    neighborCache.set(rec.key, result);
    return result;
  };

  while (recordings.length > requestedLength) {
    type Candidate = { index: number; edge: GradientRecordingPathEdge; costIncrease: number };
    let best: Candidate | null = null;

    for (let i = 1; i < recordings.length - 1; i++) {
      if (mandatory.has(recordings[i]!.key)) continue;
      const prev = recordings[i - 1]!;
      const next = recordings[i + 1]!;

      const prevNeighbors = await fetchNeighbors(prev);
      const match = prevNeighbors.find((n) => gradientRecordingKey(n.artist, n.title) === next.key);
      if (!match || match.similarity < 0.08) continue;

      const skipEdge: GradientRecordingPathEdge = {
        from: prev, to: next,
        similarity: match.similarity,
        confidence: match.confidence ?? 0.8,
        provider: match.provider ?? "recording_similarity",
      };
      const currentCost = gradientRecordingEdgeCost(edges[i - 1]!.similarity, edges[i - 1]!.confidence)
        + gradientRecordingEdgeCost(edges[i]!.similarity, edges[i]!.confidence);
      const newCost = gradientRecordingEdgeCost(skipEdge.similarity, skipEdge.confidence);
      const costIncrease = newCost - currentCost;
      if (!best || costIncrease < best.costIncrease) {
        best = { index: i, edge: skipEdge, costIncrease };
      }
    }

    if (!best) {
      return {
        path: { ...original, recordings, edges, cost: edges.reduce((sum, e) => sum + gradientRecordingEdgeCost(e.similarity, e.confidence), 0) },
        removedCount,
        compressed: false,
        partialReason: "no_validated_skip_edge",
      };
    }

    recordings.splice(best.index, 1);
    edges.splice(best.index - 1, 2, best.edge);
    removedCount++;
  }

  return {
    path: {
      ...original,
      recordings,
      edges,
      cost: edges.reduce((sum, e) => sum + gradientRecordingEdgeCost(e.similarity, e.confidence), 0),
    },
    removedCount,
    compressed: true,
    partialReason: null,
  };
}

/**
 * Recursively split the weakest/widest path gaps. A bridge must be supported by
 * both adjacent recordings; left-only similarity can never win by itself.
 */
export async function densifyGradientRecordingPath(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions = {},
): Promise<GradientDensificationResult> {
  const maxQueries = Math.max(0, options.maxQueries ?? 96);
  const neighborLimit = Math.max(6, options.neighborLimit ?? 48);
  const minBridgeSimilarity = clamp(options.minBridgeSimilarity ?? 0.12, 0.01, 0.95);
  const familiarityWeight = clamp(options.familiarityWeight ?? 0.18, 0, 0.6);
  const recordings = [...original.recordings];
  const edges = [...original.edges];
  const operations: GradientDensificationOperation[] = [];
  const neighborCache = new Map<string, Promise<GradientRecordingNeighbor[]>>();
  let queryCount = 0;

  const neighbors = async (recording: GradientRecording) => {
    const existing = neighborCache.get(recording.key);
    if (existing) return existing;
    if (queryCount >= maxQueries) return [];
    queryCount++;
    const promise = provider.neighbors(recording, neighborLimit).catch(() => [] as GradientRecordingNeighbor[]);
    neighborCache.set(recording.key, promise);
    return promise;
  };

  let stoppedReason: GradientDensificationResult["stoppedReason"] = "requested_length";
  while (recordings.length < requestedLength) {
    if (queryCount >= maxQueries) {
      stoppedReason = "query_budget";
      break;
    }
    const currentPath: GradientRecordingPath = { ...original, recordings, edges, cost: 0 };
    const positioned = positionGradientRecordingPath(currentPath);
    const used = new Set(recordings.map((row) => row.key));
    const artistCounts = new Map<string, number>();
    for (const row of recordings) {
      const artist = normalizeForComparison(row.artist);
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    }
    let best: {
      gapIndex: number;
      recording: GradientRecording;
      left: GradientRecordingNeighbor;
      right: GradientRecordingNeighbor;
      score: number;
      bottleneck: number;
      familiarityTarget: number;
      familiarityActual: number | null;
    } | null = null;

    for (let gapIndex = 0; gapIndex < recordings.length - 1; gapIndex++) {
      const leftRecording = recordings[gapIndex]!;
      const rightRecording = recordings[gapIndex + 1]!;
      const [leftRows, rightRows] = await Promise.all([neighbors(leftRecording), neighbors(rightRecording)]);
      const leftMap = new Map(leftRows.map((row) => [row.key || gradientRecordingKey(row.artist, row.title), row]));
      const rightMap = new Map(rightRows.map((row) => [row.key || gradientRecordingKey(row.artist, row.title), row]));
      const leftPosition = positioned[gapIndex]?.routePosition ?? gapIndex / Math.max(1, recordings.length - 1);
      const rightPosition = positioned[gapIndex + 1]?.routePosition ?? (gapIndex + 1) / Math.max(1, recordings.length - 1);
      const midpoint = (leftPosition + rightPosition) / 2;
      const targetFamiliarity = gradientFamiliarityTarget(midpoint);

      for (const [candidateKey, left] of leftMap) {
        const right = rightMap.get(candidateKey);
        if (!right || used.has(candidateKey)) continue;
        const candidate = normalizeRecording(left);
        if (!candidate) continue;
        const bottleneck = Math.min(clamp(left.similarity, 0, 1), clamp(right.similarity, 0, 1));
        if (bottleneck < minBridgeSimilarity) continue;
        const candidateArtist = normalizeForComparison(candidate.artist);
        if (options.endpointArtists && midpoint >= 0.22 && midpoint <= 0.78) {
          const [a, b] = options.endpointArtists.map(normalizeForComparison) as [string, string];
          if (candidateArtist === a || candidateArtist === b) continue;
        }
        const familiarityActual = options.familiarity?.(candidate) ?? null;
        const familiarityFit = familiarityActual == null ? 0.5 : 1 - Math.abs(familiarityActual - targetFamiliarity);
        const repeatPenalty = Math.max(0, (artistCounts.get(candidateArtist) ?? 0) - 0.25) * 0.07;
        const bridge = harmonicMean(clamp(left.similarity, 0, 1), clamp(right.similarity, 0, 1));
        const currentWeakness = 1 - (edges[gapIndex]?.similarity ?? 0.5);
        const score = bottleneck * 0.62 + bridge * 0.2 + familiarityFit * familiarityWeight + currentWeakness * 0.08 - repeatPenalty;
        if (!best || score > best.score) {
          best = { gapIndex, recording: candidate, left, right, score, bottleneck, familiarityTarget: targetFamiliarity, familiarityActual };
        }
      }
    }

    if (!best) {
      stoppedReason = queryCount >= maxQueries ? "query_budget" : "no_bridge";
      break;
    }

    const leftRecording = recordings[best.gapIndex]!;
    const rightRecording = recordings[best.gapIndex + 1]!;
    const leftEdge: GradientRecordingPathEdge = {
      from: leftRecording,
      to: best.recording,
      similarity: clamp(best.left.similarity, 0.01, 1),
      confidence: clamp(best.left.confidence ?? 0.8, 0.05, 1),
      provider: best.left.provider ?? "recording_similarity",
    };
    const rightEdge: GradientRecordingPathEdge = {
      from: best.recording,
      to: rightRecording,
      similarity: clamp(best.right.similarity, 0.01, 1),
      confidence: clamp(best.right.confidence ?? 0.8, 0.05, 1),
      provider: best.right.provider ?? "recording_similarity",
    };
    recordings.splice(best.gapIndex + 1, 0, best.recording);
    edges.splice(best.gapIndex, 1, leftEdge, rightEdge);
    operations.push({
      gapIndex: best.gapIndex,
      left: `${leftRecording.artist} — ${leftRecording.title}`,
      inserted: `${best.recording.artist} — ${best.recording.title}`,
      right: `${rightRecording.artist} — ${rightRecording.title}`,
      leftSimilarity: leftEdge.similarity,
      rightSimilarity: rightEdge.similarity,
      bottleneck: best.bottleneck,
      familiarityTarget: best.familiarityTarget,
      familiarityActual: best.familiarityActual,
    });
  }

  const path: GradientRecordingPath = {
    ...original,
    recordings,
    edges,
    queryCount: original.queryCount + queryCount,
    cost: edges.reduce((sum, edge) => sum + gradientRecordingEdgeCost(edge.similarity, edge.confidence), 0),
  };
  return { path, positioned: positionGradientRecordingPath(path), operations, queryCount, stoppedReason };
}
