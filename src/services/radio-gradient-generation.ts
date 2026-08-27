import { createHash } from "node:crypto";
import { getDb } from "../db/database";
import {
  finishGeneration,
  getGeneration,
  getGenerationTracks,
  getSeeds,
  getStation,
  parseRadioSettings,
  replaceGenerationTracks,
  type RadioTrackRow,
} from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";
import {
  canonicalRadioTrackKey,
  generateStation,
  presentGeneration,
  regenerateTail,
  type TasteTrack,
} from "./radio";
import {
  gradientRouteDiagnostics,
  gradientRouteSupportsPosition,
  planGradientRoute,
  routePositionForArtist,
  type GradientRoutePlan,
} from "./radio-gradient-route";
import { buildGradientRouteTrackPool } from "./radio-gradient-tracks";

interface PoolTrack {
  canonicalKey: string;
  artist: string;
  title: string;
  album: string | null;
  durationMs: number | null;
  isrc: string | null;
  spotifyId: string | null;
  navidromeId: string | null;
  musicbrainzId: string | null;
  playbackSource: string | null;
  availability: string;
  baseScore: number;
  routePosition: number | null;
  routeConfidence: number;
  metadata: Record<string, unknown>;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

function numericMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jitter(seed: string, key: string) {
  const hex = createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 12);
  return parseInt(hex, 16) / 0xffffffffffff;
}

function normalizedExistingScores(tracks: RadioTrackRow[]) {
  const values = tracks.map((track) => track.selection_score).filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = Math.max(0.0001, max - min);
  return new Map(tracks.map((track) => [track.id, clamp((track.selection_score - min) / range, 0, 1)]));
}

function routeInfoForExisting(track: RadioTrackRow, plan: GradientRoutePlan | null) {
  const metadata = parseMetadata(track.metadata_json);
  const explicit = numericMetadata(metadata, "gradientRoutePosition");
  if (explicit != null) {
    return {
      position: clamp(explicit, 0, 1),
      confidence: clamp(numericMetadata(metadata, "gradientRouteConfidence") ?? 0.7, 0.05, 1),
      routeArtist: typeof metadata.gradientRouteArtist === "string" ? metadata.gradientRouteArtist : track.artist,
    };
  }
  return routePositionForArtist(plan, track.artist);
}

function mergeProviderScore(metadata: Record<string, unknown>, provider: string, score: number) {
  const raw = metadata.providerScores;
  const providerScores = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
  const current = typeof providerScores[provider] === "number" ? providerScores[provider] as number : 0;
  providerScores[provider] = Math.max(current, score);
  return { ...metadata, providerScores };
}

function existingPool(tracks: RadioTrackRow[], plan: GradientRoutePlan | null) {
  const normalized = normalizedExistingScores(tracks);
  return tracks.map((track): PoolTrack => {
    const metadata = parseMetadata(track.metadata_json);
    const route = routeInfoForExisting(track, plan);
    return {
      canonicalKey: track.canonical_key,
      artist: track.artist,
      title: track.title,
      album: track.album,
      durationMs: track.duration_ms,
      isrc: track.isrc,
      spotifyId: track.spotify_id,
      navidromeId: track.navidrome_id,
      musicbrainzId: track.musicbrainz_id,
      playbackSource: track.playback_source,
      availability: track.availability_status,
      baseScore: normalized.get(track.id) ?? 0.5,
      routePosition: route?.position ?? null,
      routeConfidence: route?.confidence ?? 0,
      metadata: route ? {
        ...metadata,
        gradientRoutePosition: route.position,
        gradientRouteConfidence: route.confidence,
        gradientRouteArtist: route.routeArtist,
      } : metadata,
    };
  });
}

function mergePoolTrack(map: Map<string, PoolTrack>, track: PoolTrack) {
  const current = map.get(track.canonicalKey);
  if (!current) {
    map.set(track.canonicalKey, track);
    return;
  }
  const preferRoute = track.routePosition != null && (
    current.routePosition == null || track.routeConfidence > current.routeConfidence
  );
  map.set(track.canonicalKey, {
    ...current,
    album: current.album || track.album,
    durationMs: current.durationMs || track.durationMs,
    isrc: current.isrc || track.isrc,
    spotifyId: current.spotifyId || track.spotifyId,
    navidromeId: current.navidromeId || track.navidromeId,
    musicbrainzId: current.musicbrainzId || track.musicbrainzId,
    playbackSource: current.playbackSource || track.playbackSource,
    availability: current.availability !== "unknown" ? current.availability : track.availability,
    baseScore: Math.max(current.baseScore, track.baseScore),
    routePosition: preferRoute ? track.routePosition : current.routePosition,
    routeConfidence: preferRoute ? track.routeConfidence : current.routeConfidence,
    metadata: { ...current.metadata, ...track.metadata },
  });
}

function toStored(track: PoolTrack, selectionScore: number, target: number) {
  const routePosition = track.routePosition == null ? null : clamp(track.routePosition, 0, 1);
  return {
    canonical_key: track.canonicalKey,
    artist: track.artist,
    title: track.title,
    album: track.album,
    duration_ms: track.durationMs,
    isrc: track.isrc,
    spotify_id: track.spotifyId,
    navidrome_id: track.navidromeId,
    musicbrainz_id: track.musicbrainzId,
    playback_source: track.playbackSource,
    availability_status: track.availability,
    pinned: 0,
    manual: 0,
    selection_score: selectionScore,
    // This is now a discovered musical-route coordinate, not the physical
    // playlist index. Unknown coordinates remain NULL rather than lying to UI.
    trajectory_position: routePosition,
    metadata_json: JSON.stringify({
      ...track.metadata,
      ...(routePosition == null ? {} : {
        gradientRoutePosition: routePosition,
        gradientRouteConfidence: track.routeConfidence,
        trajectoryTarget: target,
        trajectoryDelta: Math.abs(routePosition - target),
        trajectoryCoordinateKind: "musical_route",
      }),
    }),
  };
}

function copyLockedTrack(track: RadioTrackRow, plan: GradientRoutePlan | null, target: number) {
  const metadata = parseMetadata(track.metadata_json);
  const route = routeInfoForExisting(track, plan);
  return {
    canonical_key: track.canonical_key,
    artist: track.artist,
    title: track.title,
    album: track.album,
    duration_ms: track.duration_ms,
    isrc: track.isrc,
    spotify_id: track.spotify_id,
    navidrome_id: track.navidrome_id,
    musicbrainz_id: track.musicbrainz_id,
    playback_source: track.playback_source,
    availability_status: track.availability_status,
    pinned: track.pinned,
    manual: track.manual,
    selection_score: track.selection_score,
    trajectory_position: route?.position ?? null,
    metadata_json: JSON.stringify({
      ...metadata,
      ...(route ? {
        gradientRoutePosition: route.position,
        gradientRouteConfidence: route.confidence,
        gradientRouteArtist: route.routeArtist,
        trajectoryTarget: target,
        trajectoryDelta: Math.abs(route.position - target),
        trajectoryCoordinateKind: "musical_route",
      } : {}),
    }),
  };
}

function selectRouteSequence(
  pool: PoolTrack[],
  plan: GradientRoutePlan,
  requestedLength: number,
  randomSeed: string,
  settings: ReturnType<typeof parseRadioSettings>,
  lockedByPosition: Map<number, RadioTrackRow>,
) {
  const output: Array<ReturnType<typeof toStored> & { position?: number }> = [];
  const used = new Set<string>();
  const artistLast = new Map<string, number>();
  for (const track of lockedByPosition.values()) used.add(track.canonical_key);
  let previousRoutePosition: number | null = null;
  const baseTolerance = clamp(Math.max(
    settings.gradientRouteWidth,
    plan.maxGap * 0.62,
    requestedLength <= 1 ? 1 : 1.05 / (requestedLength - 1),
  ), 0.1, 0.42);
  const candidates = [...pool];

  const candidateScore = (candidate: PoolTrack, position: number, strict: boolean) => {
    if (used.has(candidate.canonicalKey)) return -Infinity;
    const target = requestedLength <= 1 ? 0 : position / (requestedLength - 1);
    const supported = gradientRouteSupportsPosition(plan, target);
    const routePosition = candidate.routePosition;
    let routeScore = 0;
    if (supported) {
      if (routePosition == null) {
        if (strict) return -Infinity;
        routeScore -= settings.gradientRouteStrength * 0.9;
      } else {
        const distance = Math.abs(routePosition - target);
        if (strict && distance > baseTolerance * 1.2) return -Infinity;
        if (strict && previousRoutePosition != null && routePosition < previousRoutePosition - Math.max(0.08, baseTolerance * 0.55)) {
          return -Infinity;
        }
        const sigma = Math.max(0.06, baseTolerance * 0.72);
        const closeness = Math.exp(-0.5 * Math.pow(distance / sigma, 2));
        routeScore += closeness * settings.gradientRouteStrength;
        routeScore += candidate.routeConfidence * 0.45;
        routeScore -= distance * settings.gradientRouteStrength * 1.7;
        if (previousRoutePosition != null && routePosition < previousRoutePosition) {
          routeScore -= (previousRoutePosition - routePosition) * settings.gradientRouteStrength * 3.2;
        }
        if (position === 0 && routePosition <= Math.max(0.04, baseTolerance * 0.4)) routeScore += 0.75;
        if (position === requestedLength - 1 && routePosition >= 1 - Math.max(0.04, baseTolerance * 0.4)) routeScore += 0.75;
      }
    }

    const artist = normalizeForComparison(candidate.artist);
    const last = artistLast.get(artist);
    const gap = last == null ? Infinity : position - last;
    const repeatPenalty = Number.isFinite(gap)
      ? Math.max(0, (settings.artistCooldown - gap + 1) / Math.max(1, settings.artistCooldown)) * settings.repeatStrength
      : 0;
    return candidate.baseScore * 0.85 + routeScore - repeatPenalty + jitter(randomSeed, `${position}:${candidate.canonicalKey}`) * 0.02;
  };

  for (let position = 0; position < requestedLength; position++) {
    const target = requestedLength <= 1 ? 0 : position / (requestedLength - 1);
    const locked = lockedByPosition.get(position);
    if (locked) {
      const stored = copyLockedTrack(locked, plan, target);
      output.push({ ...stored, position });
      const route = stored.trajectory_position;
      if (route != null) previousRoutePosition = route;
      artistLast.set(normalizeForComparison(stored.artist), position);
      continue;
    }

    let best: PoolTrack | null = null;
    let bestScore = -Infinity;
    for (const strict of [true, false]) {
      for (const candidate of candidates) {
        const score = candidateScore(candidate, position, strict);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best) break;
    }
    if (!best) continue;
    used.add(best.canonicalKey);
    artistLast.set(normalizeForComparison(best.artist), position);
    if (best.routePosition != null) previousRoutePosition = best.routePosition;
    output.push({ ...toStored(best, bestScore, target), position });
  }
  return output;
}

async function reshapeGradientGeneration(
  generationId: string,
  options: { preserveBefore?: number; preservePinned?: boolean } = {},
) {
  const generation = getGeneration(generationId);
  if (!generation) return null;
  const station = getStation(generation.station_id);
  if (!station || station.type !== "gradient") return presentGeneration(generationId);
  const settings = parseRadioSettings(generation.settings_snapshot_json);
  if (settings.gradientAlgorithm === "blend") return presentGeneration(generationId);

  const seeds = getSeeds(station.id);
  const plan = await planGradientRoute(seeds, settings);
  const existing = getGenerationTracks(generationId);
  const previousDiagnostics = generation.diagnostics_json ? JSON.parse(generation.diagnostics_json) as Record<string, unknown> : {};
  if (!plan.usable) {
    finishGeneration(generationId, generation.status === "failed" ? "failed" : "partial", {
      ...previousDiagnostics,
      gradient_route: gradientRouteDiagnostics(plan),
      gradient_route_warning: "No connected musical route was discovered; legacy ordering retained and its percentages must not be interpreted as musical coordinates.",
    });
    return presentGeneration(generationId);
  }

  const pool = new Map<string, PoolTrack>();
  for (const track of existingPool(existing, plan)) mergePoolTrack(pool, track);
  const routePool = await buildGradientRouteTrackPool(plan, generation.requested_length);
  for (const track of routePool.tracks) {
    const metadata = mergeProviderScore({
      gradientRoutePosition: track.routePosition,
      gradientRouteConfidence: track.routeConfidence,
      gradientRouteArtist: track.routeArtist,
      gradientRouteSource: track.source,
      trajectoryCoordinateKind: "musical_route",
    }, "gradient_route", track.providerScore);
    mergePoolTrack(pool, {
      canonicalKey: canonicalRadioTrackKey(track.artist, track.title),
      artist: track.artist,
      title: track.title,
      album: null,
      durationMs: null,
      isrc: null,
      spotifyId: null,
      navidromeId: null,
      musicbrainzId: track.mbid,
      playbackSource: null,
      availability: "unknown",
      baseScore: track.providerScore,
      routePosition: track.routePosition,
      routeConfidence: track.routeConfidence,
      metadata,
    });
  }

  const locked = new Map<number, RadioTrackRow>();
  const preserveBefore = Math.max(0, options.preserveBefore ?? 0);
  for (const track of existing) {
    if (track.position < preserveBefore || (options.preservePinned && Boolean(track.pinned))) {
      locked.set(track.position, track);
    }
  }

  const sequence = selectRouteSequence(
    [...pool.values()],
    plan,
    generation.requested_length,
    generation.random_seed,
    settings,
    locked,
  );
  replaceGenerationTracks(generationId, sequence);
  getDb().query("UPDATE radio_generations SET generator_version=? WHERE id=?")
    .run(`radio-v4-gradient-${settings.gradientAlgorithm}`, generationId);
  const positioned = sequence.filter((track) => track.trajectory_position != null).length;
  const backtracks = sequence.reduce((count, track, index) => {
    if (index === 0 || track.trajectory_position == null || sequence[index - 1]!.trajectory_position == null) return count;
    return count + (track.trajectory_position! < sequence[index - 1]!.trajectory_position! - 0.04 ? 1 : 0);
  }, 0);
  finishGeneration(generationId, sequence.length >= Math.min(generation.requested_length, 3)
    ? ((generation.status === "partial" || routePool.errors.length) ? "partial" : "ready")
    : "partial", {
    ...previousDiagnostics,
    selected_count: sequence.length,
    gradient_route: gradientRouteDiagnostics(plan),
    gradient_route_candidate_count: routePool.tracks.length,
    gradient_route_positioned_count: positioned,
    gradient_route_positioned_ratio: sequence.length ? Number((positioned / sequence.length).toFixed(4)) : 0,
    gradient_route_backtracks: backtracks,
    gradient_route_errors: routePool.errors,
  });
  return presentGeneration(generationId);
}

export async function generateRadioStationWithGradient(
  stationId: string,
  input: { length?: number; tasteProfile?: TasteTrack[] } = {},
) {
  const station = getStation(stationId);
  if (!station) throw new Error("Radio station not found");
  const generated = await generateStation(stationId, input);
  if (station.type !== "gradient") return generated;
  return await reshapeGradientGeneration(generated.id) ?? generated;
}

export async function regenerateRadioTailWithGradient(
  generationId: string,
  fromPosition: number,
  tasteProfile?: TasteTrack[],
) {
  const generation = getGeneration(generationId);
  if (!generation) throw new Error("Radio generation not found");
  const station = getStation(generation.station_id);
  if (!station) throw new Error("Radio station not found");
  const regenerated = await regenerateTail(generationId, fromPosition, tasteProfile);
  if (station.type !== "gradient") return regenerated;
  return await reshapeGradientGeneration(generationId, { preserveBefore: fromPosition, preservePinned: true }) ?? regenerated;
}
