import * as lastfm from "./lastfm";
import { normalizeForComparison } from "../domain/normalization";
import type { GradientAlgorithm, RadioSeedRow, RadioSettings } from "../db/repositories/radio";

export interface GradientArtistNeighbor {
  name: string;
  similarity: number;
}

export interface GradientGraphProvider {
  similarArtists(artist: string, limit: number): Promise<GradientArtistNeighbor[]>;
}

export interface GradientTrackProvider {
  artistTopTracks(artist: string, limit: number): Promise<Array<{
    artist: string;
    title: string;
    mbid?: string | null;
    score: number;
  }>>;
}

export interface GradientRouteNode {
  artist: string;
  position: number;
  confidence: number;
  segment: number;
  kind: "anchor" | "bridge";
}

export interface GradientRouteEdge {
  from: string;
  to: string;
  similarity: number;
}

export interface GradientRouteSegment {
  index: number;
  fromSeedId: string;
  toSeedId: string;
  fromLabel: string;
  toLabel: string;
  fromArtist: string | null;
  toArtist: string | null;
  fromAnchors?: string[];
  toAnchors?: string[];
  fromPosition: number;
  toPosition: number;
  connected: boolean;
  queryCount: number;
  confidence: number;
  edges: GradientRouteEdge[];
  fallbackReason?: string;
}

export interface GradientRoutePlan {
  algorithm: GradientAlgorithm;
  usable: boolean;
  nodes: GradientRouteNode[];
  segments: GradientRouteSegment[];
  queryCount: number;
  confidence: number;
  maxGap: number;
}

export interface GradientRouteTrackCandidate {
  artist: string;
  title: string;
  mbid: string | null;
  provider: "gradient_route";
  providerScore: number;
  routePosition: number;
  routeConfidence: number;
  routeArtist: string;
}

type ArtistRecord = { key: string; name: string };
type GraphEdge = { to: string; similarity: number };
type Graph = {
  nodes: Map<string, ArtistRecord>;
  edges: Map<string, Map<string, GraphEdge>>;
};

type PathResult = {
  keys: string[];
  cost: number;
  edges: GradientRouteEdge[];
};

type FrontierItem = {
  key: string;
  name: string;
  depth: number;
  quality: number;
};

type RegionPathResult = {
  path: PathResult | null;
  graph: Graph;
  queryCount: number;
  fromArtist: string | null;
  toArtist: string | null;
};

const ROUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_REGION_ANCHORS = 4;
const similarArtistCache = new Map<string, { expires: number; promise: Promise<GradientArtistNeighbor[]> }>();
const topTrackCache = new Map<string, { expires: number; promise: Promise<Array<{ artist: string; title: string; mbid: string | null; score: number }>> }>();
const tagAnchorCache = new Map<string, { expires: number; promise: Promise<Array<{ artist: string; weight: number }>> }>();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function artistKey(value: string) {
  return normalizeForComparison(value);
}

function edgeCost(similarity: number) {
  return -Math.log(clamp(similarity, 0.025, 1)) + 0.035;
}

function newGraph(): Graph {
  return { nodes: new Map(), edges: new Map() };
}

function rememberArtist(graph: Graph, name: string) {
  const key = artistKey(name);
  if (!key) return null;
  if (!graph.nodes.has(key)) graph.nodes.set(key, { key, name: name.trim() });
  if (!graph.edges.has(key)) graph.edges.set(key, new Map());
  return key;
}

function addEdge(graph: Graph, fromName: string, toName: string, similarity: number) {
  const from = rememberArtist(graph, fromName);
  const to = rememberArtist(graph, toName);
  if (!from || !to || from === to) return;
  const score = clamp(similarity, 0.025, 1);
  const addOne = (a: string, b: string) => {
    const bucket = graph.edges.get(a)!;
    const current = bucket.get(b);
    if (!current || score > current.similarity) bucket.set(b, { to: b, similarity: score });
  };
  // Last.fm similarity is directional. For route discovery, a returned local
  // relationship is treated as undirected adjacency so asymmetric API results
  // do not make the musical graph arbitrarily one-way.
  addOne(from, to);
  addOne(to, from);
}

function getEdge(graph: Graph, from: string, to: string) {
  return graph.edges.get(from)?.get(to) ?? null;
}

function shortestPath(graph: Graph, start: string, end: string): PathResult | null {
  if (start === end) return { keys: [start], cost: 0, edges: [] };
  const distance = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  const unvisited = new Set<string>(graph.nodes.keys());

  while (unvisited.size) {
    let current: string | null = null;
    let best = Infinity;
    for (const key of unvisited) {
      const value = distance.get(key) ?? Infinity;
      if (value < best) {
        best = value;
        current = key;
      }
    }
    if (!current || best === Infinity) break;
    unvisited.delete(current);
    if (current === end) break;
    for (const edge of graph.edges.get(current)?.values() ?? []) {
      if (!unvisited.has(edge.to)) continue;
      const next = best + edgeCost(edge.similarity);
      if (next < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, next);
        previous.set(edge.to, current);
      }
    }
  }

  if (!distance.has(end)) return null;
  const keys = [end];
  while (keys[0] !== start) {
    const parent = previous.get(keys[0]!);
    if (!parent) return null;
    keys.unshift(parent);
  }
  return pathResultFromKeys(graph, keys);
}

function distancesFrom(graph: Graph, start: string) {
  const distance = new Map<string, number>([[start, 0]]);
  const pending = new Set(graph.nodes.keys());
  while (pending.size) {
    let current: string | null = null;
    let best = Infinity;
    for (const key of pending) {
      const value = distance.get(key) ?? Infinity;
      if (value < best) {
        best = value;
        current = key;
      }
    }
    if (!current || best === Infinity) break;
    pending.delete(current);
    for (const edge of graph.edges.get(current)?.values() ?? []) {
      if (!pending.has(edge.to)) continue;
      const next = best + edgeCost(edge.similarity);
      if (next < (distance.get(edge.to) ?? Infinity)) distance.set(edge.to, next);
    }
  }
  return distance;
}

function pathResultFromKeys(graph: Graph, keys: string[]): PathResult | null {
  const edges: GradientRouteEdge[] = [];
  let cost = 0;
  for (let index = 1; index < keys.length; index++) {
    const fromKey = keys[index - 1]!;
    const toKey = keys[index]!;
    const edge = getEdge(graph, fromKey, toKey);
    if (!edge) return null;
    const from = graph.nodes.get(fromKey)?.name ?? fromKey;
    const to = graph.nodes.get(toKey)?.name ?? toKey;
    cost += edgeCost(edge.similarity);
    edges.push({ from, to, similarity: edge.similarity });
  }
  return { keys, cost, edges };
}

function scenicPath(graph: Graph, start: string, end: string, shortest: PathResult): PathResult {
  if (shortest.keys.length <= 1) return shortest;
  const toEnd = distancesFrom(graph, end);
  const shortestEdges = shortest.keys.length - 1;
  const targetEdges = clamp(shortestEdges + 2, 4, 8);
  const maxEdges = Math.min(10, targetEdges + 2);
  const beamWidth = 140;
  type State = { keys: string[]; cost: number; estimate: number };
  let beam: State[] = [{ keys: [start], cost: 0, estimate: toEnd.get(start) ?? shortest.cost }];
  const complete: State[] = [];

  for (let step = 0; step < maxEdges; step++) {
    const nextStates: State[] = [];
    for (const state of beam) {
      const current = state.keys.at(-1)!;
      for (const edge of graph.edges.get(current)?.values() ?? []) {
        if (state.keys.includes(edge.to)) continue;
        const heuristic = toEnd.get(edge.to);
        if (heuristic == null) continue;
        const keys = [...state.keys, edge.to];
        const cost = state.cost + edgeCost(edge.similarity);
        const edgesUsed = keys.length - 1;
        const estimate = cost + heuristic * 0.9 + Math.max(0, edgesUsed - targetEdges) * 0.12;
        const candidate = { keys, cost, estimate };
        if (edge.to === end) complete.push(candidate);
        else nextStates.push(candidate);
      }
    }
    nextStates.sort((a, b) => a.estimate - b.estimate);
    beam = nextStates.slice(0, beamWidth);
    if (!beam.length) break;
  }

  if (!complete.length) return shortest;
  complete.sort((a, b) => {
    const aEdges = a.keys.length - 1;
    const bEdges = b.keys.length - 1;
    const aScore = a.cost + Math.abs(aEdges - targetEdges) * 0.32;
    const bScore = b.cost + Math.abs(bEdges - targetEdges) * 0.32;
    return aScore - bScore;
  });
  return pathResultFromKeys(graph, complete[0]!.keys) ?? shortest;
}

async function defaultSimilarArtists(artist: string, limit: number): Promise<GradientArtistNeighbor[]> {
  const key = `${artistKey(artist)}:${limit}`;
  const now = Date.now();
  const current = similarArtistCache.get(key);
  if (current && current.expires > now) return current.promise;
  const promise = lastfm.getSimilarArtists(artist, limit).then((rows) => rows
    .filter((row) => row.name.trim() && row.match > 0)
    .map((row) => ({ name: row.name, similarity: clamp(row.match, 0, 1) }))
  );
  similarArtistCache.set(key, { expires: now + ROUTE_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    similarArtistCache.delete(key);
    throw error;
  }
}

const DEFAULT_GRAPH_PROVIDER: GradientGraphProvider = { similarArtists: defaultSimilarArtists };

const DEFAULT_TRACK_PROVIDER: GradientTrackProvider = {
  async artistTopTracks(artist, limit) {
    const key = `${artistKey(artist)}:${limit}`;
    const now = Date.now();
    const current = topTrackCache.get(key);
    if (current && current.expires > now) return current.promise;
    const promise = lastfm.getArtistTopTracks(artist, limit).then((rows) => rows.map((row) => ({
      artist: row.artist || artist,
      title: row.name,
      mbid: row.mbid || null,
      score: clamp(row.match, 0, 1),
    })));
    topTrackCache.set(key, { expires: now + ROUTE_CACHE_TTL_MS, promise });
    try {
      return await promise;
    } catch (error) {
      topTrackCache.delete(key);
      throw error;
    }
  },
};

async function expandBatch(
  graph: Graph,
  items: FrontierItem[],
  provider: GradientGraphProvider,
  neighborLimit: number,
  expanded: Set<string>,
) {
  const fresh = items.filter((item) => !expanded.has(item.key));
  fresh.forEach((item) => expanded.add(item.key));
  const results = await Promise.all(fresh.map(async (item) => {
    try {
      return { item, neighbors: await provider.similarArtists(item.name, neighborLimit) };
    } catch {
      return { item, neighbors: [] as GradientArtistNeighbor[] };
    }
  }));
  const discovered: FrontierItem[] = [];
  for (const { item, neighbors } of results) {
    for (const neighbor of neighbors) {
      if (!neighbor.name.trim() || neighbor.similarity <= 0) continue;
      addEdge(graph, item.name, neighbor.name, neighbor.similarity);
      const key = artistKey(neighbor.name);
      if (!key) continue;
      discovered.push({
        key,
        name: neighbor.name,
        depth: item.depth + 1,
        quality: item.quality * clamp(neighbor.similarity, 0.025, 1),
      });
    }
  }
  return { queries: fresh.length, discovered };
}

function dedupeFrontier(items: FrontierItem[], seen: Map<string, FrontierItem>, cap: number) {
  for (const item of items) {
    const current = seen.get(item.key);
    if (!current || item.quality > current.quality) seen.set(item.key, item);
  }
  return [...seen.values()]
    .sort((a, b) => (a.depth - b.depth) || (b.quality - a.quality))
    .slice(0, cap);
}

function uniqueArtists(values: string[], cap = MAX_REGION_ANCHORS) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const name = value.trim();
    const key = artistKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(name);
    if (output.length >= cap) break;
  }
  return output;
}

function bestShortestPath(
  graph: Graph,
  startKeys: string[],
  endKeys: string[],
): { path: PathResult; start: string; end: string } | null {
  let best: { path: PathResult; start: string; end: string; adjusted: number } | null = null;
  for (let startIndex = 0; startIndex < startKeys.length; startIndex++) {
    const start = startKeys[startIndex]!;
    for (let endIndex = 0; endIndex < endKeys.length; endIndex++) {
      const end = endKeys[endIndex]!;
      const path = shortestPath(graph, start, end);
      if (!path) continue;
      // Broad seeds are regions, but their higher-ranked representative artists
      // should still be preferred when two graph routes are similarly good.
      const adjusted = path.cost + startIndex * 0.12 + endIndex * 0.12;
      if (!best || adjusted < best.adjusted) best = { path, start, end, adjusted };
    }
  }
  return best ? { path: best.path, start: best.start, end: best.end } : null;
}

/**
 * Discover one bounded graph route between two musical regions. Each side may
 * expose several representative artists; they share one search budget instead
 * of launching an expensive independent graph crawl for every anchor pair.
 */
export async function discoverGradientArtistPathBetweenRegions(
  fromArtists: string[],
  toArtists: string[],
  algorithm: Exclude<GradientAlgorithm, "blend">,
  provider: GradientGraphProvider = DEFAULT_GRAPH_PROVIDER,
): Promise<RegionPathResult> {
  const graph = newGraph();
  const from = uniqueArtists(fromArtists);
  const to = uniqueArtists(toArtists);
  const startKeys = from.flatMap((artist) => {
    const key = rememberArtist(graph, artist);
    return key ? [key] : [];
  });
  const endKeys = to.flatMap((artist) => {
    const key = rememberArtist(graph, artist);
    return key ? [key] : [];
  });
  if (!startKeys.length || !endKeys.length) {
    return { path: null, graph, queryCount: 0, fromArtist: null, toArtist: null };
  }

  const overlap = startKeys.find((key) => endKeys.includes(key));
  if (overlap) {
    const artist = graph.nodes.get(overlap)?.name ?? overlap;
    return {
      path: { keys: [overlap], cost: 0, edges: [] },
      graph,
      queryCount: 0,
      fromArtist: artist,
      toArtist: artist,
    };
  }

  const scenic = algorithm === "scenic";
  const beamPerSide = scenic ? 5 : 4;
  const frontierCap = scenic ? 48 : 34;
  const neighborLimit = scenic ? 28 : 20;
  const queryBudget = scenic ? 56 : 40;
  const maxRounds = scenic ? 8 : 7;
  const expanded = new Set<string>();
  let queryCount = 0;
  let foundAt: number | null = null;
  let startFrontier: FrontierItem[] = startKeys.map((key, index) => ({
    key,
    name: graph.nodes.get(key)!.name,
    depth: 0,
    quality: 1 / (1 + index * 0.2),
  }));
  let endFrontier: FrontierItem[] = endKeys.map((key, index) => ({
    key,
    name: graph.nodes.get(key)!.name,
    depth: 0,
    quality: 1 / (1 + index * 0.2),
  }));
  const startSeen = new Map(startFrontier.map((item) => [item.key, item]));
  const endSeen = new Map(endFrontier.map((item) => [item.key, item]));

  for (let round = 0; round < maxRounds && queryCount < queryBudget; round++) {
    const startBatch = startFrontier.filter((item) => !expanded.has(item.key)).slice(0, beamPerSide);
    const endBatch = endFrontier.filter((item) => !expanded.has(item.key)).slice(0, beamPerSide);
    if (!startBatch.length && !endBatch.length) break;
    const remaining = queryBudget - queryCount;
    const combined = [...startBatch, ...endBatch].slice(0, remaining);
    const startBatchKeys = new Set(startBatch.map((item) => item.key));
    const actualStart = combined.filter((item) => startBatchKeys.has(item.key));
    const actualEnd = combined.filter((item) => !startBatchKeys.has(item.key));

    const [left, right] = await Promise.all([
      expandBatch(graph, actualStart, provider, neighborLimit, expanded),
      expandBatch(graph, actualEnd, provider, neighborLimit, expanded),
    ]);
    queryCount += left.queries + right.queries;
    startFrontier = dedupeFrontier(left.discovered, startSeen, frontierCap);
    endFrontier = dedupeFrontier(right.discovered, endSeen, frontierCap);

    const candidate = bestShortestPath(graph, startKeys, endKeys);
    if (candidate && foundAt == null) foundAt = queryCount;
    // Refine briefly after the first connection so the selected route is not
    // just whichever representative pair happened to touch first.
    if (candidate && foundAt != null && queryCount >= foundAt + (scenic ? 12 : 6)) break;
  }

  const shortest = bestShortestPath(graph, startKeys, endKeys);
  if (!shortest) {
    return { path: null, graph, queryCount, fromArtist: null, toArtist: null };
  }
  const path = scenic ? scenicPath(graph, shortest.start, shortest.end, shortest.path) : shortest.path;
  return {
    path,
    graph,
    queryCount,
    fromArtist: graph.nodes.get(shortest.start)?.name ?? shortest.start,
    toArtist: graph.nodes.get(shortest.end)?.name ?? shortest.end,
  };
}

export async function discoverGradientArtistPath(
  fromArtist: string,
  toArtist: string,
  algorithm: Exclude<GradientAlgorithm, "blend">,
  provider: GradientGraphProvider = DEFAULT_GRAPH_PROVIDER,
): Promise<{ path: PathResult | null; graph: Graph; queryCount: number }> {
  const discovered = await discoverGradientArtistPathBetweenRegions([fromArtist], [toArtist], algorithm, provider);
  return { path: discovered.path, graph: discovered.graph, queryCount: discovered.queryCount };
}

function parseSeedTracks(raw: string | null) {
  try {
    const parsed = raw ? JSON.parse(raw) as { tracks?: unknown } : {};
    if (!Array.isArray(parsed.tracks)) return [] as Array<{ artist: string; weight: number }>;
    return parsed.tracks.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.artist !== "string" || !row.artist.trim()) return [];
      return [{ artist: row.artist.trim(), weight: typeof row.weight === "number" ? row.weight : 1 }];
    });
  } catch {
    return [] as Array<{ artist: string; weight: number }>;
  }
}

function rankAnchorArtists(rows: Array<{ artist: string; weight: number }>, explicit?: string | null) {
  const weighted = new Map<string, { artist: string; weight: number }>();
  const add = (artist: string, weight: number) => {
    const name = artist.trim();
    const key = artistKey(name);
    if (!key) return;
    const current = weighted.get(key);
    if (!current) weighted.set(key, { artist: name, weight });
    else current.weight += weight;
  };
  if (explicit?.trim()) add(explicit, 5);
  for (const row of rows) add(row.artist, Math.max(0.01, row.weight));
  return [...weighted.values()]
    .sort((a, b) => b.weight - a.weight || a.artist.localeCompare(b.artist))
    .slice(0, MAX_REGION_ANCHORS)
    .map((row) => row.artist);
}

async function genreAnchorArtists(label: string) {
  const key = normalizeForComparison(label);
  const now = Date.now();
  const current = tagAnchorCache.get(key);
  if (current && current.expires > now) return current.promise;
  const promise = lastfm.getTagTopTracks(label, 24).then((tracks) => tracks.map((track) => ({
    artist: track.artist,
    weight: Math.max(0.05, track.match || 1),
  })));
  tagAnchorCache.set(key, { expires: now + ROUTE_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    tagAnchorCache.delete(key);
    throw error;
  }
}

/**
 * Explicit track/artist/album seeds are narrow anchors. Playlist, liked,
 * library and collection seeds are musical regions represented by several
 * distinct artists from their supplied snapshot. Genre seeds derive several
 * representative artists from Last.fm rather than collapsing to one act.
 */
export async function gradientSeedAnchorArtists(seed: RadioSeedRow): Promise<string[]> {
  const supplied = parseSeedTracks(seed.metadata_json);
  if (["track", "artist", "album"].includes(seed.seed_type) && seed.artist?.trim()) {
    return [seed.artist.trim()];
  }
  if (seed.seed_type === "genre") {
    let genreRows: Array<{ artist: string; weight: number }> = [];
    try { genreRows = await genreAnchorArtists(seed.label); } catch { /* fallback to supplied metadata */ }
    return rankAnchorArtists([...supplied, ...genreRows], seed.artist);
  }
  return rankAnchorArtists(supplied, seed.artist);
}

function normalizedSeedPositions(seeds: RadioSeedRow[]) {
  return [...seeds]
    .map((seed, index) => ({
      seed,
      position: clamp(seed.position ?? (seeds.length <= 1 ? 0 : index / Math.max(1, seeds.length - 1)), 0, 1),
    }))
    .sort((a, b) => a.position - b.position);
}

function routeNodesFromPath(
  graph: Graph,
  path: PathResult,
  segment: number,
  fromPosition: number,
  toPosition: number,
) {
  if (path.keys.length === 1) {
    const artist = graph.nodes.get(path.keys[0]!)?.name ?? path.keys[0]!;
    return [{ artist, position: fromPosition, confidence: 1, segment, kind: "anchor" as const }];
  }
  const distances = path.edges.map((edge) => edgeCost(edge.similarity));
  const total = Math.max(0.0001, distances.reduce((sum, value) => sum + value, 0));
  let cursor = 0;
  return path.keys.map((key, index): GradientRouteNode => {
    const artist = graph.nodes.get(key)?.name ?? key;
    if (index > 0) cursor += distances[index - 1]!;
    const local = index === path.keys.length - 1 ? 1 : cursor / total;
    const previous = path.edges[index - 1]?.similarity;
    const next = path.edges[index]?.similarity;
    const confidence = index === 0 || index === path.keys.length - 1
      ? 1
      : Math.sqrt(Math.max(0.025, previous ?? 0.025) * Math.max(0.025, next ?? 0.025));
    return {
      artist,
      position: fromPosition + (toPosition - fromPosition) * local,
      confidence: clamp(confidence, 0.05, 1),
      segment,
      kind: index === 0 || index === path.keys.length - 1 ? "anchor" : "bridge",
    };
  });
}

export async function planGradientRoute(
  seeds: RadioSeedRow[],
  settings: RadioSettings,
  provider: GradientGraphProvider = DEFAULT_GRAPH_PROVIDER,
): Promise<GradientRoutePlan> {
  const algorithm = settings.gradientAlgorithm;
  if (algorithm === "blend" || seeds.length < 2) {
    return { algorithm, usable: false, nodes: [], segments: [], queryCount: 0, confidence: 0, maxGap: 1 };
  }

  const positioned = normalizedSeedPositions(seeds);
  const anchorEntries = await Promise.all(positioned.map(async ({ seed }) => [
    seed.id,
    await gradientSeedAnchorArtists(seed),
  ] as const));
  const anchorsBySeed = new Map(anchorEntries);
  const nodes: GradientRouteNode[] = [];
  const segments: GradientRouteSegment[] = [];
  let queryCount = 0;

  for (let index = 0; index < positioned.length - 1; index++) {
    const left = positioned[index]!;
    const right = positioned[index + 1]!;
    const fromAnchors = anchorsBySeed.get(left.seed.id) ?? [];
    const toAnchors = anchorsBySeed.get(right.seed.id) ?? [];
    const base = {
      index,
      fromSeedId: left.seed.id,
      toSeedId: right.seed.id,
      fromLabel: left.seed.label,
      toLabel: right.seed.label,
      fromArtist: fromAnchors[0] ?? null,
      toArtist: toAnchors[0] ?? null,
      fromAnchors,
      toAnchors,
      fromPosition: left.position,
      toPosition: right.position,
    };

    if (!fromAnchors.length || !toAnchors.length) {
      segments.push({ ...base, connected: false, queryCount: 0, confidence: 0, edges: [], fallbackReason: "seed_has_no_artist_anchor" });
      continue;
    }

    const discovered = await discoverGradientArtistPathBetweenRegions(fromAnchors, toAnchors, algorithm, provider);
    queryCount += discovered.queryCount;
    if (!discovered.path) {
      segments.push({ ...base, connected: false, queryCount: discovered.queryCount, confidence: 0, edges: [], fallbackReason: "no_graph_path_found" });
      continue;
    }

    const edgeSimilarities = discovered.path.edges.map((edge) => edge.similarity);
    const confidence = edgeSimilarities.length
      ? Math.exp(edgeSimilarities.reduce((sum, similarity) => sum + Math.log(Math.max(0.025, similarity)), 0) / edgeSimilarities.length)
      : 1;
    segments.push({
      ...base,
      fromArtist: discovered.fromArtist ?? base.fromArtist,
      toArtist: discovered.toArtist ?? base.toArtist,
      connected: true,
      queryCount: discovered.queryCount,
      confidence: clamp(confidence, 0.05, 1),
      edges: discovered.path.edges,
    });
    nodes.push(...routeNodesFromPath(discovered.graph, discovered.path, index, left.position, right.position));
  }

  const merged = new Map<string, GradientRouteNode>();
  for (const node of nodes) {
    const key = `${artistKey(node.artist)}:${node.position.toFixed(5)}`;
    const current = merged.get(key);
    if (!current || node.confidence > current.confidence) merged.set(key, node);
  }
  const ordered = [...merged.values()].sort((a, b) => a.position - b.position || b.confidence - a.confidence);
  let maxGap = ordered.length > 1 ? 0 : 1;
  for (let index = 1; index < ordered.length; index++) {
    maxGap = Math.max(maxGap, ordered[index]!.position - ordered[index - 1]!.position);
  }
  const connected = segments.filter((segment) => segment.connected);
  const confidence = connected.length
    ? connected.reduce((sum, segment) => sum + segment.confidence, 0) / connected.length
    : 0;
  return {
    algorithm,
    usable: connected.length > 0 && ordered.length >= 2,
    nodes: ordered,
    segments,
    queryCount,
    confidence,
    maxGap,
  };
}

export function gradientRouteSupportsPosition(plan: GradientRoutePlan | null, position: number) {
  if (!plan?.usable) return false;
  return plan.segments.some((segment) => segment.connected && position >= segment.fromPosition - 1e-6 && position <= segment.toPosition + 1e-6);
}

export function routePositionForArtist(plan: GradientRoutePlan | null, artist: string) {
  if (!plan?.usable) return null;
  const key = artistKey(artist);
  const matches = plan.nodes.filter((node) => artistKey(node.artist) === key);
  if (!matches.length) return null;
  const best = matches.sort((a, b) => b.confidence - a.confidence)[0]!;
  return { position: best.position, confidence: best.confidence, routeArtist: best.artist };
}

export async function materializeGradientRouteTracks(
  plan: GradientRoutePlan | null,
  provider: GradientTrackProvider = DEFAULT_TRACK_PROVIDER,
): Promise<{ candidates: GradientRouteTrackCandidate[]; errors: string[] }> {
  if (!plan?.usable) return { candidates: [], errors: [] };
  const candidates: GradientRouteTrackCandidate[] = [];
  const errors: string[] = [];
  const uniqueNodes = [...new Map(plan.nodes.map((node) => [`${artistKey(node.artist)}:${node.position.toFixed(4)}`, node])).values()];

  for (let offset = 0; offset < uniqueNodes.length; offset += 4) {
    const batch = uniqueNodes.slice(offset, offset + 4);
    const rows = await Promise.all(batch.map(async (node) => {
      try {
        return { node, tracks: await provider.artistTopTracks(node.artist, 7), error: null as string | null };
      } catch (error) {
        return { node, tracks: [] as Awaited<ReturnType<GradientTrackProvider["artistTopTracks"]>>, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const row of rows) {
      if (row.error) errors.push(`${row.node.artist}: ${row.error}`);
      for (const track of row.tracks) {
        if (!track.artist.trim() || !track.title.trim()) continue;
        candidates.push({
          artist: track.artist,
          title: track.title,
          mbid: track.mbid ?? null,
          provider: "gradient_route",
          providerScore: clamp((0.3 + track.score * 0.7) * row.node.confidence, 0.05, 1),
          routePosition: row.node.position,
          routeConfidence: row.node.confidence,
          routeArtist: row.node.artist,
        });
      }
    }
  }
  return { candidates, errors };
}

export function gradientRouteDiagnostics(plan: GradientRoutePlan | null) {
  if (!plan) return null;
  return {
    algorithm: plan.algorithm,
    usable: plan.usable,
    confidence: Number(plan.confidence.toFixed(4)),
    query_count: plan.queryCount,
    max_gap: Number(plan.maxGap.toFixed(4)),
    route_nodes: plan.nodes.map((node) => ({
      artist: node.artist,
      position: Number(node.position.toFixed(4)),
      confidence: Number(node.confidence.toFixed(4)),
      segment: node.segment,
      kind: node.kind,
    })),
    segments: plan.segments.map((segment) => ({
      index: segment.index,
      from: segment.fromLabel,
      to: segment.toLabel,
      from_artist: segment.fromArtist,
      to_artist: segment.toArtist,
      from_anchors: segment.fromAnchors ?? [],
      to_anchors: segment.toAnchors ?? [],
      from_position: segment.fromPosition,
      to_position: segment.toPosition,
      connected: segment.connected,
      confidence: Number(segment.confidence.toFixed(4)),
      query_count: segment.queryCount,
      fallback_reason: segment.fallbackReason ?? null,
      edges: segment.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        similarity: Number(edge.similarity.toFixed(4)),
      })),
    })),
  };
}
