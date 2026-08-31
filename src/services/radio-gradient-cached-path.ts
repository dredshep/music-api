import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import { assessCachedAcousticTransition } from "./radio-transition-quality";
import {
  gradientRecording,
  gradientRecordingEdgeCost,
  type GradientRecording,
  type GradientRecordingPath,
  type GradientRecordingPathEdge,
} from "./radio-gradient-recording-path";

type CachedEdgeRow = {
  neighbor_key: string;
  artist: string;
  title: string;
  recording_mbid: string | null;
  provider: string;
  similarity: number;
  confidence: number;
};

type HeapEntry = { key: string; cost: number };

type CachedNeighbor = {
  recording: GradientRecording;
  similarity: number;
  confidence: number;
  provider: string;
};

export type ValidatedCachedPathOptions = {
  maxExpanded?: number;
  neighborLimit?: number;
  excludedKeys?: Set<string>;
  popularityBias?: number;
  releaseAgeBias?: number;
  endpointArtists?: [string, string] | null;
  maxNeighborsPerArtist?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function strength(similarity: number, confidence: number) {
  return clamp(similarity, 0.01, 1) * clamp(confidence, 0.05, 1);
}

function heapPush(heap: HeapEntry[], entry: HeapEntry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]!.cost <= entry.cost) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = entry;
}

function heapPop(heap: HeapEntry[]) {
  if (!heap.length) return null;
  const root = heap[0]!;
  const tail = heap.pop()!;
  if (!heap.length) return root;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right]!.cost < heap[left]!.cost ? right : left;
    if (heap[child]!.cost >= tail.cost) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = tail;
  return root;
}

/**
 * Traverse the persisted recording graph with the same acoustic safety semantics
 * used by online discovery. Provider columns are never independently MAXed: an
 * edge's similarity/confidence pair always comes from one real provider row.
 * Multiple-provider agreement may raise confidence, but raw similarity remains
 * attached to the selected provider evidence.
 */
export function discoverValidatedCachedRecordingPath(
  starts: GradientRecording[],
  ends: GradientRecording[],
  options: ValidatedCachedPathOptions = {},
): GradientRecordingPath | null {
  if (!starts.length || !ends.length) return null;
  const db = getDb();
  const maxExpanded = Math.max(1, options.maxExpanded ?? 12_000);
  const neighborLimit = Math.max(4, Math.min(100, options.neighborLimit ?? 40));
  const supplied = new Map([...starts, ...ends].map((row) => [row.key, row]));
  const endKeys = new Set(ends.map((row) => row.key));
  const endpointKeys = new Set([...starts, ...ends].map((row) => row.key));
  const overlap = starts.find((row) => endKeys.has(row.key));
  if (overlap) {
    return {
      recordings: [overlap],
      edges: [],
      cost: 0,
      queryCount: 0,
      nodesVisited: 1,
      forwardFrontierSize: 0,
      backwardFrontierSize: 0,
      intersection: overlap.key,
    };
  }

  const popBias = options.popularityBias ?? 0;
  const wantsRarity = popBias < -0.3;
  const endpointArtistNorms = new Set(
    (options.endpointArtists ?? []).map(normalizeForComparison),
  );
  const maxNeighborsPerArtist = options.maxNeighborsPerArtist ?? (wantsRarity ? 4 : undefined);

  const degreeQuery = db.prepare(
    `SELECT (SELECT COUNT(*) FROM recording_similarity_edges WHERE source_key = ?1)
          + (SELECT COUNT(*) FROM recording_similarity_edges WHERE target_key = ?1)`,
  );
  const degreeCache = new Map<string, number>();
  const nodeDegree = (key: string): number => {
    const cached = degreeCache.get(key);
    if (cached !== undefined) return cached;
    const row = degreeQuery.get(key) as { [key: string]: number } | undefined;
    const degree = row ? Object.values(row)[0] ?? 0 : 0;
    degreeCache.set(key, degree);
    return degree;
  };
  const hubPenalty = (key: string): number => {
    if (!wantsRarity || endpointKeys.has(key)) return 0;
    const degree = nodeDegree(key);
    const normalized = Math.max(0, (degree - 60) / 160);
    return Math.abs(popBias) * normalized * 3.5;
  };

  const outgoing = db.prepare(`SELECT
      e.target_key AS neighbor_key,
      n.artist,n.title,n.recording_mbid,
      e.provider,e.similarity,e.confidence
    FROM recording_similarity_edges e
    JOIN recording_similarity_nodes n ON n.canonical_key=e.target_key
    WHERE e.source_key=?
    ORDER BY (e.similarity*e.confidence) DESC
    LIMIT ?`);
  const incoming = db.prepare(`SELECT
      e.source_key AS neighbor_key,
      n.artist,n.title,n.recording_mbid,
      e.provider,e.similarity,e.confidence
    FROM recording_similarity_edges e
    JOIN recording_similarity_nodes n ON n.canonical_key=e.source_key
    WHERE e.target_key=?
    ORDER BY (e.similarity*e.confidence) DESC
    LIMIT ?`);
  const nodeQuery = db.prepare("SELECT artist,title,recording_mbid FROM recording_similarity_nodes WHERE canonical_key=?");
  const nodeCache = new Map<string, GradientRecording>(supplied);

  const loadNode = (key: string) => {
    const existing = nodeCache.get(key);
    if (existing) return existing;
    const row = nodeQuery.get(key) as { artist: string; title: string; recording_mbid: string | null } | undefined;
    if (!row) return null;
    const recording = gradientRecording(row.artist, row.title, row.recording_mbid);
    nodeCache.set(key, recording);
    return recording;
  };

  const loadNeighbors = (source: GradientRecording): CachedNeighbor[] => {
    const rows = [
      ...(outgoing.all(source.key, neighborLimit * 4) as CachedEdgeRow[]),
      ...(incoming.all(source.key, neighborLimit * 4) as CachedEdgeRow[]),
    ];
    const grouped = new Map<string, CachedEdgeRow[]>();
    for (const row of rows) {
      if (row.neighbor_key === source.key) continue;
      const bucket = grouped.get(row.neighbor_key);
      if (bucket) bucket.push(row);
      else grouped.set(row.neighbor_key, [row]);
    }

    const accepted: CachedNeighbor[] = [];
    for (const [neighborKey, evidenceRows] of grouped) {
      if (options.excludedKeys?.has(neighborKey) && !endpointKeys.has(neighborKey)) continue;
      const first = evidenceRows[0]!;
      const target = loadNode(neighborKey)
        ?? gradientRecording(first.artist, first.title, first.recording_mbid);
      nodeCache.set(target.key, target);

      let acoustic;
      try {
        acoustic = assessCachedAcousticTransition(source, target);
      } catch {
        acoustic = null;
      }
      if (acoustic?.catastrophic) continue;

      const best = [...evidenceRows].sort((a, b) =>
        strength(b.similarity, b.confidence) - strength(a.similarity, a.confidence),
      )[0]!;
      const providerCount = new Set(evidenceRows.map((row) => row.provider)).size;
      let confidence = clamp(
        best.confidence + Math.min(0.18, Math.max(0, providerCount - 1) * 0.09),
        0.05,
        1,
      );
      if (acoustic && acoustic.evidenceCount >= 3 && acoustic.score != null) {
        if (acoustic.score < 0.35) confidence *= clamp(acoustic.score / 0.35, 0.35, 1);
        else if (acoustic.score >= 0.72) confidence = clamp(confidence + 0.06, 0.05, 1);
      }
      accepted.push({
        recording: target,
        similarity: clamp(best.similarity, 0.01, 1),
        confidence: clamp(confidence, 0.05, 1),
        provider: best.provider,
      });
    }

    const artistCountMap = new Map<string, number>();
    return accepted
      .sort((a, b) => strength(b.similarity, b.confidence) - strength(a.similarity, a.confidence))
      .filter((neighbor) => {
        if (!endpointArtistNorms.size) return true;
        if (endpointKeys.has(neighbor.recording.key)) return true;
        return !endpointArtistNorms.has(normalizeForComparison(neighbor.recording.artist));
      })
      .filter((neighbor) => {
        if (!maxNeighborsPerArtist) return true;
        const norm = normalizeForComparison(neighbor.recording.artist);
        const count = (artistCountMap.get(norm) ?? 0) + 1;
        artistCountMap.set(norm, count);
        return count <= maxNeighborsPerArtist;
      })
      .slice(0, neighborLimit);
  };

  const distances = new Map<string, number>();
  const parents = new Map<string, { parentKey: string; edge: GradientRecordingPathEdge }>();
  const expanded = new Set<string>();
  const heap: HeapEntry[] = [];
  for (const start of starts) {
    if ((distances.get(start.key) ?? Infinity) > 0) {
      distances.set(start.key, 0);
      heapPush(heap, { key: start.key, cost: 0 });
    }
  }

  let reachedEnd: string | null = null;
  while (heap.length && expanded.size < maxExpanded) {
    const current = heapPop(heap)!;
    if (options.excludedKeys?.has(current.key) && !endpointKeys.has(current.key)) continue;
    if (expanded.has(current.key)) continue;
    if (current.cost > (distances.get(current.key) ?? Infinity) + 1e-9) continue;
    const source = loadNode(current.key);
    if (!source) continue;
    expanded.add(current.key);
    if (endKeys.has(current.key)) {
      reachedEnd = current.key;
      break;
    }

    for (const neighbor of loadNeighbors(source)) {
      if (expanded.has(neighbor.recording.key)) continue;
      const edgeCost = gradientRecordingEdgeCost(neighbor.similarity, neighbor.confidence);
      const penalty = hubPenalty(neighbor.recording.key);
      const candidateCost = current.cost + edgeCost + penalty;
      if (candidateCost + 1e-9 >= (distances.get(neighbor.recording.key) ?? Infinity)) continue;
      distances.set(neighbor.recording.key, candidateCost);
      parents.set(neighbor.recording.key, {
        parentKey: source.key,
        edge: {
          from: source,
          to: neighbor.recording,
          similarity: neighbor.similarity,
          confidence: neighbor.confidence,
          provider: neighbor.provider,
        },
      });
      heapPush(heap, { key: neighbor.recording.key, cost: candidateCost });
    }
  }

  if (!reachedEnd) return null;
  const recordings: GradientRecording[] = [];
  const edges: GradientRecordingPathEdge[] = [];
  let cursor = reachedEnd;
  const endRecording = loadNode(cursor);
  if (!endRecording) return null;
  recordings.unshift(endRecording);
  while (parents.has(cursor)) {
    const parent = parents.get(cursor)!;
    edges.unshift(parent.edge);
    const parentRecording = loadNode(parent.parentKey);
    if (!parentRecording) return null;
    recordings.unshift(parentRecording);
    cursor = parent.parentKey;
  }

  return {
    recordings,
    edges,
    cost: distances.get(reachedEnd) ?? edges.reduce(
      (sum, edge) => sum + gradientRecordingEdgeCost(edge.similarity, edge.confidence),
      0,
    ),
    queryCount: 0,
    nodesVisited: expanded.size,
    forwardFrontierSize: heap.length,
    backwardFrontierSize: 0,
    intersection: reachedEnd,
  };
}
