import type { GradientAlgorithm, RadioSeedRow, RadioSettings } from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";
import * as lastfm from "./lastfm";
import { densifyGradientRecordingPathWithSubpathFallback } from "./radio-gradient-densify-subpath";
import { discoverValidatedCachedRecordingPath } from "./radio-gradient-cached-path";
import {
  compressGradientRecordingPath,
  discoverGradientRecordingPath,
  gradientRecording,
  gradientRecordingEdgeCost,
  refinePathNovelty,
  searchGradientRecordingPath,
  type GradientDensificationOperation,
  type GradientPathSearchOptions,
  type GradientRecording,
  type GradientRecordingNeighborProvider,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "./radio-gradient-recording-path";
import {
  budgetRemaining,
  budgetTotalUsed,
  createRouteBudget,
  isBudgetExhausted,
  snapshotBudget,
  type GradientRouteBudget,
  type GradientRouteBudgetSnapshot,
} from "./radio-gradient-budget";
import { log } from "../middleware/logging";

export type GradientSeedConstraint = "exact_track" | "artist" | "region";

export interface GradientSeedRecordingRegion {
  seedId: string;
  label: string;
  seedType: RadioSeedRow["seed_type"];
  position: number;
  constraint: GradientSeedConstraint;
  requestedArtist: string | null;
  requestedTitle: string | null;
  recordings: GradientRecording[];
}

export interface GradientRecordingRouteSegment {
  index: number;
  fromSeedId: string;
  toSeedId: string;
  fromLabel: string;
  toLabel: string;
  fromPosition: number;
  toPosition: number;
  connected: boolean;
  queryCount: number;
  nodesVisited: number;
  forwardFrontierSize: number;
  backwardFrontierSize: number;
  frontierIntersection: string | null;
  pathSearchMs: number;
  densificationMs: number;
  rawRecordings: GradientRecording[];
  recordings: Array<GradientRecording & { routePosition: number; routeConfidence: number }>;
  edges: GradientRecordingPathEdge[];
  densificationOperations: GradientDensificationOperation[];
  densificationStoppedReason: string | null;
  fallbackReason: string | null;
  compressionPartial: string | null;
}

export interface GradientRecordingRoutePlan {
  algorithm: GradientAlgorithm;
  state: "complete" | "partial" | "no_route";
  usable: boolean;
  complete: boolean;
  requestedLength: number;
  regions: GradientSeedRecordingRegion[];
  segments: GradientRecordingRouteSegment[];
  recordings: Array<GradientRecording & {
    routePosition: number | null;
    routeConfidence: number;
    waypointSeedId?: string;
    waypointConstraint?: GradientSeedConstraint;
    unsupportedWaypoint?: boolean;
  }>;
  queryCount: number;
  bottleneck: number | null;
  middleNovelty: {
    count: number;
    knownCount: number;
    unknownCount: number;
    meanFamiliarity: number | null;
  };
  endpointStatus: {
    startSatisfied: boolean;
    endSatisfied: boolean;
    startConstraint: GradientSeedConstraint | null;
    endConstraint: GradientSeedConstraint | null;
  };
  budget: GradientRouteBudgetSnapshot | null;
}

export interface GradientSeedRecordingSources {
  artistTracks(artist: string, limit: number): Promise<Array<{ artist: string; title: string; mbid?: string | null; weight?: number }>>;
  albumTracks(artist: string, album: string, limit: number): Promise<Array<{ artist: string; title: string; mbid?: string | null; weight?: number }>>;
  genreTracks(genre: string, limit: number): Promise<Array<{ artist: string; title: string; mbid?: string | null; weight?: number }>>;
}

const DEFAULT_SOURCES: GradientSeedRecordingSources = {
  async artistTracks(artist, limit) {
    const rows = await lastfm.getArtistTopTracks(artist, limit);
    return rows.map((row) => ({ artist, title: row.name, mbid: row.mbid || null, weight: row.match }));
  },
  async albumTracks(artist, album, limit) {
    const rows = await lastfm.getAlbumTracks(artist, album);
    return rows.slice(0, limit).map((row) => ({ artist: row.artist || artist, title: row.name, mbid: row.mbid || null, weight: row.match }));
  },
  async genreTracks(genre, limit) {
    const rows = await lastfm.getTagTopTracks(genre, limit);
    return rows.map((row) => ({ artist: row.artist, title: row.name, mbid: row.mbid || null, weight: row.match }));
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function elapsedMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(2));
}

function parseObject(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactSeedMbid(seed: RadioSeedRow) {
  const metadata = parseObject(seed.metadata_json);
  return text(metadata.recordingMbid) ?? text(metadata.musicbrainzId) ?? text(metadata.mbid);
}

function metadataRecordings(seed: RadioSeedRow) {
  const metadata = parseObject(seed.metadata_json);
  if (!Array.isArray(metadata.tracks)) return [] as Array<GradientRecording & { weight: number }>;
  return metadata.tracks.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    const artist = text(row.artist);
    const title = text(row.title) ?? text(row.name);
    if (!artist || !title) return [];
    const mbid = text(row.recordingMbid) ?? text(row.musicbrainzId) ?? text(row.mbid);
    const weight = typeof row.weight === "number" && Number.isFinite(row.weight) ? row.weight : 1;
    return [{ ...gradientRecording(artist, title, mbid), weight }];
  });
}

function dedupeRecordings(rows: Array<GradientRecording & { weight?: number }>, limit: number) {
  const best = new Map<string, GradientRecording & { weight: number }>();
  for (const row of rows) {
    if (!row.artist.trim() || !row.title.trim()) continue;
    const current = best.get(row.key);
    const weight = Number.isFinite(row.weight) ? Number(row.weight) : 1;
    if (!current || weight > current.weight) best.set(row.key, { ...row, weight });
  }
  return [...best.values()]
    .sort((a, b) => b.weight - a.weight || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ weight: _weight, ...row }) => row);
}

function positionedSeeds(seeds: RadioSeedRow[]) {
  return [...seeds]
    .map((seed, index) => ({
      seed,
      position: clamp(seed.position ?? (seeds.length <= 1 ? 0 : index / Math.max(1, seeds.length - 1)), 0, 1),
    }))
    .sort((a, b) => a.position - b.position);
}

export async function gradientSeedRecordingRegion(
  seed: RadioSeedRow,
  position: number,
  sources: GradientSeedRecordingSources = DEFAULT_SOURCES,
): Promise<GradientSeedRecordingRegion> {
  let constraint: GradientSeedConstraint = "region";
  let recordings: GradientRecording[] = [];
  if (seed.seed_type === "track" && seed.artist?.trim() && seed.title?.trim()) {
    constraint = "exact_track";
    recordings = [gradientRecording(seed.artist, seed.title, exactSeedMbid(seed))];
  } else if (seed.seed_type === "artist" && seed.artist?.trim()) {
    constraint = "artist";
    try {
      const rows = await sources.artistTracks(seed.artist, 14);
      recordings = dedupeRecordings(rows.map((row) => ({
        ...gradientRecording(seed.artist!, row.title, row.mbid || null),
        weight: row.weight ?? 1,
      })), 14);
    } catch { /* empty region becomes an honest unsupported waypoint */ }
  } else if (seed.seed_type === "album" && seed.artist?.trim()) {
    try {
      const rows = await sources.albumTracks(seed.artist, seed.label, 24);
      recordings = dedupeRecordings(rows.map((row) => ({
        ...gradientRecording(row.artist || seed.artist!, row.title, row.mbid || null),
        weight: row.weight ?? 1,
      })), 24);
    } catch { /* fall through to supplied metadata */ }
  } else if (seed.seed_type === "genre") {
    try {
      const rows = await sources.genreTracks(seed.label, 24);
      recordings = dedupeRecordings(rows.map((row) => ({
        ...gradientRecording(row.artist, row.title, row.mbid || null),
        weight: row.weight ?? 1,
      })), 24);
    } catch { /* fall through to supplied metadata */ }
  }

  if (!recordings.length) recordings = dedupeRecordings(metadataRecordings(seed), 24);
  if (!recordings.length && seed.artist?.trim() && seed.title?.trim()) {
    recordings = [gradientRecording(seed.artist, seed.title, exactSeedMbid(seed))];
  }

  return {
    seedId: seed.id,
    label: seed.label,
    seedType: seed.seed_type,
    position,
    constraint,
    requestedArtist: seed.artist?.trim() || null,
    requestedTitle: seed.title?.trim() || null,
    recordings,
  };
}

function segmentTransitionAllocation(regions: GradientSeedRecordingRegion[], requestedLength: number) {
  const count = Math.max(0, regions.length - 1);
  if (!count) return [] as number[];
  const transitionBudget = Math.max(count, requestedLength - 1);
  const spans = Array.from({ length: count }, (_, index) => Math.max(0.0001, regions[index + 1]!.position - regions[index]!.position));
  const total = spans.reduce((sum, span) => sum + span, 0);
  const raw = spans.map((span) => span / total * transitionBudget);
  const allocated = raw.map((value) => Math.max(1, Math.floor(value)));
  let delta = transitionBudget - allocated.reduce((sum, value) => sum + value, 0);
  if (delta > 0) {
    const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let cursor = 0; delta > 0; cursor++, delta--) allocated[order[cursor % order.length]!.index]!++;
  } else if (delta < 0) {
    const order = raw.map((value, index) => ({ index, excess: allocated[index]! - value }))
      .sort((a, b) => b.excess - a.excess || a.index - b.index);
    let cursor = 0;
    while (delta < 0 && order.some((row) => allocated[row.index]! > 1)) {
      const row = order[cursor % order.length]!;
      if (allocated[row.index]! > 1) {
        allocated[row.index]!--;
        delta++;
      }
      cursor++;
    }
  }
  return allocated;
}

function segmentConfidence(edges: GradientRecordingPathEdge[]) {
  if (!edges.length) return 1;
  return Math.exp(edges.reduce((sum, edge) => sum + Math.log(Math.max(0.01, edge.similarity * edge.confidence)), 0) / edges.length);
}

function requiredWaypointRecording(region: GradientSeedRecordingRegion) {
  return region.constraint === "exact_track" || region.constraint === "artist" ? region.recordings[0] ?? null : null;
}

function satisfiesRegion(recording: GradientRecording | undefined, region: GradientSeedRecordingRegion) {
  if (!recording) return false;
  if (region.constraint === "exact_track") return recording.key === region.recordings[0]?.key;
  if (region.constraint === "artist") return Boolean(region.requestedArtist)
    && normalizeForComparison(recording.artist) === normalizeForComparison(region.requestedArtist!);
  return true;
}

function middleNovelty(
  recordings: GradientRecordingRoutePlan["recordings"],
  familiarity?: (recording: GradientRecording) => number | null,
) {
  const middle = recordings.filter((row) => row.routePosition != null && row.routePosition >= 0.33 && row.routePosition <= 0.67);
  if (!middle.length || !familiarity) return { count: middle.length, knownCount: 0, unknownCount: middle.length, meanFamiliarity: null };
  const values = middle.map((row) => familiarity(row)).filter((value): value is number => value != null);
  return {
    count: middle.length,
    knownCount: values.filter((value) => value >= 0.35).length,
    unknownCount: middle.length - values.filter((value) => value >= 0.35).length,
    meanFamiliarity: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

/**
 * When recording-level pathfinding fails because the two endpoints are in
 * completely disjoint similarity regions, try an artist-level BFS through
 * Last.fm's `artist.getSimilar` to discover intermediate bridge artists.
 * Returns a list of bridge artist names (excluding the endpoints themselves)
 * that can be used as intermediate waypoints for shorter recording-level hops.
 */
async function findArtistBridge(
  startArtist: string,
  endArtist: string,
  maxDepth = 5,
  beamWidth = 6,
  budget?: GradientRouteBudget,
): Promise<string[]> {
  const startNorm = normalizeForComparison(startArtist);
  const endNorm = normalizeForComparison(endArtist);
  if (startNorm === endNorm) return [];

  type Node = { artist: string; norm: string; depth: number; parent: string | null };
  const forwardVisited = new Map<string, Node>();
  const backwardVisited = new Map<string, Node>();
  let forwardQueue: Node[] = [{ artist: startArtist, norm: startNorm, depth: 0, parent: null }];
  let backwardQueue: Node[] = [{ artist: endArtist, norm: endNorm, depth: 0, parent: null }];
  forwardVisited.set(startNorm, forwardQueue[0]!);
  backwardVisited.set(endNorm, backwardQueue[0]!);

  for (let iteration = 0; iteration < maxDepth; iteration++) {
    if (budget && isBudgetExhausted(budget)) break;

    const expandQueue = async (queue: Node[], visited: Map<string, Node>, other: Map<string, Node>) => {
      const batch = queue.splice(0, beamWidth);
      const results = await Promise.all(batch.map(async (node) => {
        if (budget) budget.artistBridgeCalls += 1;
        try {
          return { node, similar: await lastfm.getSimilarArtists(node.artist, 30) };
        } catch { return { node, similar: [] as Awaited<ReturnType<typeof lastfm.getSimilarArtists>> }; }
      }));
      let meetingPoint: string | null = null;
      for (const { node, similar } of results) {
        for (const s of similar) {
          const norm = normalizeForComparison(s.name);
          if (visited.has(norm)) continue;
          const child: Node = { artist: s.name, norm, depth: node.depth + 1, parent: node.norm };
          visited.set(norm, child);
          queue.push(child);
          if (other.has(norm) && !meetingPoint) meetingPoint = norm;
        }
      }
      return meetingPoint;
    };

    const [fwdMeet, bwdMeet] = await Promise.all([
      expandQueue(forwardQueue, forwardVisited, backwardVisited),
      expandQueue(backwardQueue, backwardVisited, forwardVisited),
    ]);
    const meeting = fwdMeet ?? bwdMeet;
    if (meeting) {
      const path: string[] = [];
      let cursor: string | null = meeting;
      const fwdPath: string[] = [];
      while (cursor && cursor !== startNorm) {
        const node = forwardVisited.get(cursor);
        if (!node) break;
        fwdPath.unshift(node.artist);
        cursor = node.parent;
      }
      const bwdPath: string[] = [];
      cursor = backwardVisited.get(meeting)?.parent ?? null;
      while (cursor && cursor !== endNorm) {
        const node = backwardVisited.get(cursor);
        if (!node) break;
        bwdPath.push(node.artist);
        cursor = node.parent;
      }
      path.push(...fwdPath, ...bwdPath);
      const filtered = path.filter((a) => {
        const n = normalizeForComparison(a);
        return n !== startNorm && n !== endNorm;
      });
      log("info", "gradient_artist_bridge_found", {
        start: startArtist,
        end: endArtist,
        bridgeArtists: filtered,
        depth: iteration + 1,
      });
      return filtered;
    }
  }
  log("info", "gradient_artist_bridge_not_found", { start: startArtist, end: endArtist, maxDepth });
  return [];
}

/**
 * Chain recording-level hops through bridge regions. Each hop's start is
 * constrained to the exact recording where the previous hop ended, preventing
 * fabricated adjacencies from independent region-level solves.
 */
export async function chainRecordingHops(
  chainRegions: GradientRecording[][],
  provider: GradientRecordingNeighborProvider,
  pathSearchOptions: GradientPathSearchOptions,
  budget?: GradientRouteBudget,
): Promise<GradientRecordingPath | null> {
  if (chainRegions.length < 2) return null;
  const chainRecordings: GradientRecording[] = [];
  const chainEdges: GradientRecordingPathEdge[] = [];
  let chainQueryCount = 0;
  let hopStartCandidates = chainRegions[0]!;
  for (let hop = 0; hop < chainRegions.length - 1; hop++) {
    if (budget && isBudgetExhausted(budget)) break;
    const hopMaxQueries = budget
      ? Math.min(pathSearchOptions.maxQueries ?? 64, budgetRemaining(budget))
      : pathSearchOptions.maxQueries;
    const result = await searchGradientRecordingPath(
      hopStartCandidates, chainRegions[hop + 1]!, provider,
      { ...pathSearchOptions, maxQueries: hopMaxQueries },
    );
    if (budget) budget.chainedRecordingQueries += result.queryCount;
    if (!result.path) return null;
    chainQueryCount += result.queryCount;
    const start = hop === 0 ? 0 : 1;
    chainRecordings.push(...result.path.recordings.slice(start));
    chainEdges.push(...result.path.edges.slice(start > 0 ? start - 1 : 0));
    const lastRecording = result.path.recordings.at(-1);
    hopStartCandidates = lastRecording ? [lastRecording] : chainRegions[hop + 1]!;
  }
  if (chainRecordings.length < 2) return null;
  return {
    recordings: chainRecordings,
    edges: chainEdges,
    cost: chainEdges.reduce((sum, e) => sum + gradientRecordingEdgeCost(e.similarity, e.confidence), 0),
    queryCount: chainQueryCount,
    nodesVisited: chainRecordings.length,
    forwardFrontierSize: 0,
    backwardFrontierSize: 0,
    intersection: chainRecordings[Math.floor(chainRecordings.length / 2)]?.key ?? null,
  };
}

/** Plan one coherent recording trajectory across all requested waypoints. */
export async function planGradientRecordingRoute(input: {
  seeds: RadioSeedRow[];
  settings: RadioSettings;
  requestedLength: number;
  provider: GradientRecordingNeighborProvider;
  familiarity?: (recording: GradientRecording) => number | null;
  sources?: GradientSeedRecordingSources;
}): Promise<GradientRecordingRoutePlan> {
  const { seeds, settings, provider } = input;
  const algorithm = settings.gradientAlgorithm;
  const requestedLength = Math.max(1, input.requestedLength);
  if (algorithm === "blend" || seeds.length < 2) {
    return {
      algorithm,
      state: "no_route",
      usable: false,
      complete: false,
      requestedLength,
      regions: [],
      segments: [],
      recordings: [],
      queryCount: 0,
      bottleneck: null,
      middleNovelty: { count: 0, knownCount: 0, unknownCount: 0, meanFamiliarity: null },
      endpointStatus: { startSatisfied: false, endSatisfied: false, startConstraint: null, endConstraint: null },
      budget: null,
    };
  }

  const positions = positionedSeeds(seeds);
  const regions = await Promise.all(positions.map(({ seed, position }) => gradientSeedRecordingRegion(seed, position, input.sources ?? DEFAULT_SOURCES)));
  const allocation = segmentTransitionAllocation(regions, requestedLength);
  const segments: GradientRecordingRouteSegment[] = [];
  const output: GradientRecordingRoutePlan["recordings"] = [];
  let queryCount = 0;
  let previousWaypoint: GradientRecording | null = null;
  const overallEndpointArtists: [string, string] | null = regions[0]?.requestedArtist && regions.at(-1)?.requestedArtist
    ? [regions[0]!.requestedArtist!, regions.at(-1)!.requestedArtist!]
    : null;
  const scenic = algorithm === "scenic";
  const budget = createRouteBudget(scenic ? 600 : 480, 45_000);

  for (let index = 0; index < regions.length - 1; index++) {
    const left = regions[index]!;
    const right = regions[index + 1]!;
    const fromCandidates = previousWaypoint ? [previousWaypoint] : left.recordings;
    const toCandidates = right.recordings;
    const base = {
      index,
      fromSeedId: left.seedId,
      toSeedId: right.seedId,
      fromLabel: left.label,
      toLabel: right.label,
      fromPosition: left.position,
      toPosition: right.position,
    };
    if (!fromCandidates.length || !toCandidates.length) {
      segments.push({
        ...base, connected: false, queryCount: 0, nodesVisited: 0, forwardFrontierSize: 0, backwardFrontierSize: 0,
        frontierIntersection: null, pathSearchMs: 0, densificationMs: 0, rawRecordings: [], recordings: [], edges: [], densificationOperations: [],
        densificationStoppedReason: null, fallbackReason: !fromCandidates.length ? "from_seed_has_no_recordings" : "to_seed_has_no_recordings", compressionPartial: null,
      });
      previousWaypoint = null;
      continue;
    }

    if (isBudgetExhausted(budget)) {
      segments.push({
        ...base, connected: false, queryCount: 0, nodesVisited: 0, forwardFrontierSize: 0, backwardFrontierSize: 0,
        frontierIntersection: null, pathSearchMs: 0, densificationMs: 0, rawRecordings: [], recordings: [], edges: [], densificationOperations: [],
        densificationStoppedReason: null, fallbackReason: "global_budget_exhausted", compressionPartial: null,
      });
      previousWaypoint = null;
      continue;
    }

    const segmentSearchBudget = Math.min(scenic ? 160 : 128, budgetRemaining(budget));
    const pathSearchOptions = {
      maxQueries: segmentSearchBudget,
      maxNodes: scenic ? 6000 : 4000,
      beamPerSide: scenic ? 6 : 5,
      frontierCap: scenic ? 400 : 300,
      neighborLimit: scenic ? 44 : 36,
      refineQueries: scenic ? 18 : 12,
    };
    const pathStartedAt = performance.now();
    const initialResult = await searchGradientRecordingPath(fromCandidates, toCandidates, provider, pathSearchOptions);
    budget.initialRecordingQueries += initialResult.queryCount;
    budget.recordingNeighborExpansions += initialResult.nodesVisited;
    let raw = initialResult.path;

    if (!raw && !isBudgetExhausted(budget)) {
      try {
        const cachedPath = discoverValidatedCachedRecordingPath(fromCandidates, toCandidates);
        if (cachedPath) {
          budget.cachedGraphNodesExpanded += cachedPath.nodesVisited;
          log("info", "gradient_cached_path_found", {
            from: left.label,
            to: right.label,
            pathLength: cachedPath.recordings.length,
            cost: cachedPath.cost,
            nodesVisited: cachedPath.nodesVisited,
            artists: cachedPath.recordings.map((r) => r.artist),
          });
          raw = cachedPath;
        } else {
          log("info", "gradient_cached_path_not_found", {
            from: left.label,
            to: right.label,
            fromCandidates: fromCandidates.length,
            toCandidates: toCandidates.length,
          });
        }
      } catch (err) {
        log("error", "gradient_cached_path_error", {
          from: left.label,
          to: right.label,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }

    if (!raw && !isBudgetExhausted(budget) && left.requestedArtist && right.requestedArtist) {
      const bridgeArtists = await findArtistBridge(left.requestedArtist, right.requestedArtist, 8, 12, budget);
      if (bridgeArtists.length) {
        const chainRegions: GradientRecording[][] = [fromCandidates];
        for (const bridgeArtist of bridgeArtists) {
          if (isBudgetExhausted(budget)) break;
          try {
            budget.bridgeTrackLookups += 1;
            const tracks = await (input.sources ?? DEFAULT_SOURCES).artistTracks(bridgeArtist, 10);
            const recordings = dedupeRecordings(
              tracks.map((row) => ({ ...gradientRecording(bridgeArtist, row.title, row.mbid || null), weight: row.weight ?? 1 })), 10,
            );
            if (recordings.length) chainRegions.push(recordings);
          } catch { /* skip failed bridge lookup */ }
        }
        chainRegions.push(toCandidates);
        raw = await chainRecordingHops(chainRegions, provider, pathSearchOptions, budget) ?? null;
      }
    }

    const pathSearchMs = elapsedMs(pathStartedAt);
    if (!raw) {
      segments.push({
        ...base, connected: false, queryCount: 0, nodesVisited: 0, forwardFrontierSize: 0, backwardFrontierSize: 0,
        frontierIntersection: null, pathSearchMs, densificationMs: 0, rawRecordings: [], recordings: [], edges: [], densificationOperations: [],
        densificationStoppedReason: null, fallbackReason: isBudgetExhausted(budget) ? "global_budget_exhausted" : "no_recording_path_found", compressionPartial: null,
      });
      previousWaypoint = null;
      continue;
    }
    queryCount += raw.queryCount;
    const targetNodes = (allocation[index] ?? 1) + 1;
    const densificationStartedAt = performance.now();
    const densifyBudget = Math.min(scenic ? 128 : 96, budgetRemaining(budget));

    let pathForDensification = raw;
    let compressionPartial: string | null = null;
    if (raw.recordings.length > targetNodes) {
      const mandatoryKeys = new Set<string>();
      if (left.constraint !== "region") for (const r of left.recordings) mandatoryKeys.add(r.key);
      if (right.constraint !== "region") for (const r of right.recordings) mandatoryKeys.add(r.key);
      const compressed = await compressGradientRecordingPath(raw, targetNodes, provider, mandatoryKeys);
      pathForDensification = compressed.path;
      if (!compressed.compressed) compressionPartial = compressed.partialReason;
    }

    if (input.familiarity && pathForDensification.recordings.length >= 4 && !isBudgetExhausted(budget)) {
      const noveltyBudget = Math.min(scenic ? 16 : 10, budgetRemaining(budget));
      const mandatoryKeys = new Set<string>();
      if (left.constraint !== "region") for (const r of left.recordings) mandatoryKeys.add(r.key);
      if (right.constraint !== "region") for (const r of right.recordings) mandatoryKeys.add(r.key);
      const refined = await refinePathNovelty(pathForDensification, provider, {
        familiarity: input.familiarity,
        maxQueries: noveltyBudget,
        neighborLimit: scenic ? 48 : 36,
        mandatoryKeys,
        endpointArtists: overallEndpointArtists,
        minTransitionSimilarity: scenic ? 0.09 : 0.12,
      });
      pathForDensification = refined.path;
      budget.densificationQueries += refined.queryCount;
    }

    const dense = await densifyGradientRecordingPathWithSubpathFallback(pathForDensification, targetNodes, provider, {
      maxQueries: densifyBudget,
      neighborLimit: scenic ? 56 : 48,
      minBridgeSimilarity: scenic ? 0.09 : 0.12,
      endpointArtists: overallEndpointArtists,
      familiarity: input.familiarity,
      familiarityWeight: scenic ? 0.26 : 0.18,
    });
    budget.densificationQueries += dense.queryCount;
    const densificationMs = elapsedMs(densificationStartedAt);
    queryCount += dense.queryCount;
    const scaled = dense.positioned.map((recording) => ({
      ...recording,
      routePosition: left.position + (right.position - left.position) * recording.routePosition,
    }));
    segments.push({
      ...base,
      connected: true,
      queryCount: raw.queryCount + dense.queryCount,
      nodesVisited: raw.nodesVisited,
      forwardFrontierSize: raw.forwardFrontierSize,
      backwardFrontierSize: raw.backwardFrontierSize,
      frontierIntersection: raw.intersection,
      pathSearchMs,
      densificationMs,
      rawRecordings: raw.recordings,
      recordings: scaled,
      edges: dense.path.edges,
      densificationOperations: dense.operations,
      densificationStoppedReason: dense.stoppedReason,
      fallbackReason: dense.path.recordings.length < targetNodes ? "densification_exhausted_before_target_length" : null,
      compressionPartial,
    });

    previousWaypoint = dense.path.recordings.at(-1) ?? null;
    for (let rowIndex = 0; rowIndex < scaled.length; rowIndex++) {
      const recording = scaled[rowIndex]!;
      const isLeftWaypoint = rowIndex === 0;
      const isRightWaypoint = rowIndex === scaled.length - 1;
      if (output.length && output.at(-1)!.key === recording.key && Math.abs((output.at(-1)!.routePosition ?? -1) - recording.routePosition) < 1e-6) continue;
      output.push({
        ...recording,
        ...(isLeftWaypoint && left.constraint !== "region" ? { waypointSeedId: left.seedId, waypointConstraint: left.constraint } : {}),
        ...(isRightWaypoint && right.constraint !== "region" ? { waypointSeedId: right.seedId, waypointConstraint: right.constraint } : {}),
      });
    }
  }

  const connectedCount = segments.filter((segment) => segment.connected).length;
  const allConnected = connectedCount === segments.length && segments.length > 0;

  if (!allConnected) {
    for (const region of regions) {
      if (region.constraint === "region") continue;
      const already = output.find((row) => row.waypointSeedId === region.seedId || (row.routePosition != null && Math.abs(row.routePosition - region.position) < 1e-6 && satisfiesRegion(row, region)));
      if (already) continue;
      const fallback = requiredWaypointRecording(region);
      if (!fallback) continue;
      output.push({
        ...fallback,
        routePosition: null,
        routeConfidence: 0,
        waypointSeedId: region.seedId,
        waypointConstraint: region.constraint,
        unsupportedWaypoint: true,
      });
    }
  }

  output.sort((a, b) => {
    if (a.routePosition == null && b.routePosition == null) {
      const aRegion = regions.find((region) => region.seedId === a.waypointSeedId)?.position ?? 0.5;
      const bRegion = regions.find((region) => region.seedId === b.waypointSeedId)?.position ?? 0.5;
      return aRegion - bRegion;
    }
    if (a.routePosition == null) {
      const target = regions.find((region) => region.seedId === a.waypointSeedId)?.position ?? 0.5;
      return target - (b.routePosition ?? target);
    }
    if (b.routePosition == null) {
      const target = regions.find((region) => region.seedId === b.waypointSeedId)?.position ?? 0.5;
      return a.routePosition - target;
    }
    return a.routePosition - b.routePosition;
  });

  const edgeSimilarities = segments.filter((segment) => segment.connected).flatMap((segment) => segment.edges.map((edge) => edge.similarity * edge.confidence));
  const bottleneck = edgeSimilarities.length ? Math.min(...edgeSimilarities) : null;
  const firstRegion = regions[0];
  const lastRegion = regions.at(-1);
  const first = output[0];
  const last = output.at(-1);
  const anyCompressionFailure = segments.some((s) => s.compressionPartial != null);
  const routeComplete = allConnected && !anyCompressionFailure;
  const state: GradientRecordingRoutePlan["state"] = routeComplete ? "complete" : connectedCount ? "partial" : "no_route";
  return {
    algorithm,
    state,
    usable: connectedCount > 0,
    complete: routeComplete,
    requestedLength,
    regions,
    segments,
    recordings: output,
    queryCount,
    bottleneck,
    middleNovelty: middleNovelty(output, input.familiarity),
    endpointStatus: {
      startSatisfied: firstRegion ? satisfiesRegion(first, firstRegion) : false,
      endSatisfied: lastRegion ? satisfiesRegion(last, lastRegion) : false,
      startConstraint: firstRegion?.constraint ?? null,
      endConstraint: lastRegion?.constraint ?? null,
    },
    budget: snapshotBudget(budget),
  };
}

export function gradientRecordingRouteConfidence(plan: GradientRecordingRoutePlan) {
  const connected = plan.segments.filter((segment) => segment.connected);
  if (!connected.length) return 0;
  return connected.reduce((sum, segment) => sum + segmentConfidence(segment.edges), 0) / connected.length;
}
