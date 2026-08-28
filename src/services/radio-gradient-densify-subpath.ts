import { normalizeForComparison } from "../domain/normalization";
import {
  densifyGradientRecordingPath,
  gradientFamiliarityTarget,
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

/**
 * Normal densification prefers a single bottleneck-safe common neighbor. If it
 * exhausts that option, probe a few weak gaps for a bounded C→D connector and
 * then resume normal densification. This avoids false `no_bridge` results caused
 * by requiring one recording to be a one-hop neighbor of both sides.
 */
export async function densifyGradientRecordingPathWithSubpathFallback(
  original: GradientRecordingPath,
  requestedLength: number,
  provider: GradientRecordingNeighborProvider,
  options: GradientDensifyOptions = {},
): Promise<GradientDensificationResult> {
  const first = await densifyGradientRecordingPath(original, requestedLength, provider, options);
  if (first.path.recordings.length >= requestedLength || first.stoppedReason !== "no_bridge") return first;
  if (requestedLength - first.path.recordings.length < 2) return first;

  const fallbackBudget = Math.max(0, Math.min(28, Math.floor((options.maxQueries ?? 96) / 3)));
  const found = await findTwoInteriorBridge(first.path, provider, options, fallbackBudget);
  if (!found.bridge) {
    return {
      ...first,
      queryCount: first.queryCount + found.queries,
      path: { ...first.path, queryCount: first.path.queryCount + found.queries },
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
  const insertedPath: GradientRecordingPath = {
    ...first.path,
    recordings,
    edges,
    queryCount: first.path.queryCount + found.queries,
  };
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
    return {
      path: insertedPath,
      positioned: positionGradientRecordingPath(insertedPath),
      operations,
      queryCount: first.queryCount + found.queries,
      stoppedReason: "requested_length",
    };
  }

  const second = await densifyGradientRecordingPath(insertedPath, requestedLength, provider, {
    ...options,
    maxQueries: Math.max(0, (options.maxQueries ?? 96) - found.queries),
  });
  return {
    ...second,
    operations: [...operations, ...second.operations],
    queryCount: first.queryCount + found.queries + second.queryCount,
  };
}
