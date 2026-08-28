import { getDb } from "../db/database";
import {
  createGeneration,
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
import { summarizeGradientStage } from "./radio-gradient-observability";
import { buildGradientFamiliarityScorer } from "./radio-gradient-familiarity";
import {
  gradientRecordingRouteConfidence,
  planGradientRecordingRoute,
  type GradientRecordingRoutePlan,
  type GradientSeedRecordingRegion,
} from "./radio-gradient-recording-plan";
import { gradientFamiliarityTarget, type GradientRecording } from "./radio-gradient-recording-path";
import {
  createValidatedGradientRecordingProvider,
  type GradientValidatedProviderDiagnostics,
} from "./radio-gradient-recording-validated-provider";
import {
  assessGradientMergedEndpoints,
  mergeGradientPlannedTail,
  type GradientHardEndpointExpectation,
  type StoredGradientTrack,
} from "./radio-gradient-tail-merge";

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

function copyStored(track: RadioTrackRow) {
  const metadata = parseObject(track.metadata_json);
  delete metadata.trajectoryCoordinateKind;
  delete metadata.gradientRoutePosition;
  delete metadata.gradientRouteConfidence;
  delete metadata.gradientRouteArtist;
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
    trajectory_position: null,
    metadata_json: JSON.stringify(metadata),
  };
}

function planMaxGap(plan: GradientRecordingRoutePlan) {
  const positions = plan.recordings.flatMap((row) => row.routePosition == null ? [] : [row.routePosition]).sort((a, b) => a - b);
  if (positions.length < 2) return 1;
  let max = 0;
  for (let index = 1; index < positions.length; index++) max = Math.max(max, positions[index]! - positions[index - 1]!);
  return max;
}

function routeDiagnostics(plan: GradientRecordingRoutePlan, provider: GradientValidatedProviderDiagnostics) {
  return {
    algorithm: plan.algorithm,
    model: "recording_path_v1",
    state: plan.state,
    usable: plan.usable,
    complete: plan.complete,
    confidence: gradientRecordingRouteConfidence(plan),
    query_count: plan.queryCount,
    max_gap: planMaxGap(plan),
    bottleneck: plan.bottleneck,
    endpoint_status: {
      start_satisfied: plan.endpointStatus.startSatisfied,
      end_satisfied: plan.endpointStatus.endSatisfied,
      start_constraint: plan.endpointStatus.startConstraint,
      end_constraint: plan.endpointStatus.endConstraint,
    },
    middle_novelty: {
      count: plan.middleNovelty.count,
      known_count: plan.middleNovelty.knownCount,
      unknown_count: plan.middleNovelty.unknownCount,
      mean_familiarity: plan.middleNovelty.meanFamiliarity,
    },
    recording_graph: {
      nodes_visited_hint: plan.segments.reduce((sum, segment) => sum + segment.rawRecordings.length, 0),
      neighbor_lookups: provider.neighborLookups,
      cache_hits: provider.cacheHits,
      cache_misses: provider.cacheMisses,
      provider_calls: provider.providerCalls,
      provider_rows: provider.providerRows,
      provider_errors: provider.providerErrors,
      acoustic_assessments: provider.acousticAssessments,
      acoustic_evidence_edges: provider.acousticEvidenceEdges,
      acoustic_penalty_edges: provider.acousticPenaltyEdges,
      catastrophic_rejected_edges: provider.catastrophicRejectedEdges,
      catastrophic_reasons: provider.catastrophicReasons,
    },
    route_nodes: plan.recordings.flatMap((row, index) => row.routePosition == null ? [] : [{
      artist: row.artist,
      title: row.title,
      recording_mbid: row.mbid,
      position: row.routePosition,
      confidence: row.routeConfidence,
      segment: plan.segments.findIndex((segment) => row.routePosition! >= segment.fromPosition - 1e-6 && row.routePosition! <= segment.toPosition + 1e-6),
      kind: row.waypointSeedId ? "anchor" : "bridge",
      waypoint_seed_id: row.waypointSeedId ?? null,
      waypoint_constraint: row.waypointConstraint ?? null,
      index,
    }]),
    segments: plan.segments.map((segment) => ({
      index: segment.index,
      from: segment.fromLabel,
      to: segment.toLabel,
      from_artist: segment.recordings[0]?.artist ?? null,
      to_artist: segment.recordings.at(-1)?.artist ?? null,
      from_anchors: plan.regions[segment.index]?.recordings.slice(0, 8).map((row) => `${row.artist} — ${row.title}`) ?? [],
      to_anchors: plan.regions[segment.index + 1]?.recordings.slice(0, 8).map((row) => `${row.artist} — ${row.title}`) ?? [],
      from_position: segment.fromPosition,
      to_position: segment.toPosition,
      connected: segment.connected,
      confidence: segment.connected && segment.edges.length
        ? Math.exp(segment.edges.reduce((sum, edge) => sum + Math.log(Math.max(0.01, edge.similarity * edge.confidence)), 0) / segment.edges.length)
        : segment.connected ? 1 : 0,
      query_count: segment.queryCount,
      fallback_reason: segment.fallbackReason,
      raw_path: segment.rawRecordings.map((row) => ({ artist: row.artist, title: row.title, recording_mbid: row.mbid })),
      densification_stopped_reason: segment.densificationStoppedReason,
      densification_operations: segment.densificationOperations,
      edges: segment.edges.map((edge) => ({
        from: edge.from.artist,
        from_title: edge.from.title,
        to: edge.to.artist,
        to_title: edge.to.title,
        similarity: edge.similarity,
        confidence: edge.confidence,
        provider: edge.provider,
      })),
    })),
  };
}

function waypointRegion(plan: GradientRecordingRoutePlan, seedId: string | undefined) {
  return seedId ? plan.regions.find((region) => region.seedId === seedId) ?? null : null;
}

function storedRouteTracks(
  plan: GradientRecordingRoutePlan,
  familiarity: (recording: GradientRecording) => number | null,
): StoredGradientTrack[] {
  return plan.recordings.map((row) => {
    const region = waypointRegion(plan, row.waypointSeedId);
    const routePosition = row.routePosition == null ? null : clamp(row.routePosition, 0, 1);
    const familiarityActual = familiarity(row);
    const metadata: Record<string, unknown> = {
      gradientRouteModel: "recording_path_v1",
      gradientRouteSource: "recording_graph",
      gradientRouteConfidence: row.routeConfidence,
      gradientRouteRecordingMbid: row.mbid,
      providerScores: { gradient_route: row.routeConfidence },
      familiarityActual,
      ...(routePosition == null ? {
        gradientRouteUnsupported: true,
      } : {
        gradientRoutePosition: routePosition,
        trajectoryCoordinateKind: "musical_route",
        familiarityTarget: gradientFamiliarityTarget(routePosition),
      }),
      ...(row.waypointSeedId ? {
        gradientWaypoint: true,
        gradientWaypointSeedId: row.waypointSeedId,
        gradientWaypointConstraint: row.waypointConstraint,
        gradientWaypointLabel: region?.label ?? null,
      } : {}),
    };
    return {
      canonical_key: canonicalRadioTrackKey(row.artist, row.title),
      artist: row.artist,
      title: row.title,
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: null,
      navidrome_id: null,
      musicbrainz_id: row.mbid,
      playback_source: null,
      availability_status: "unknown",
      pinned: 0,
      manual: 0,
      selection_score: row.routeConfidence,
      trajectory_position: routePosition,
      metadata_json: JSON.stringify(metadata),
    };
  });
}

function seedTargetIndex(region: GradientSeedRecordingRegion, length: number) {
  return Math.max(0, Math.min(Math.max(0, length - 1), Math.round(region.position * Math.max(0, length - 1))));
}

function fallbackWaypointForRegion(plan: GradientRecordingRoutePlan, region: GradientSeedRecordingRegion) {
  return plan.recordings.find((row) => row.waypointSeedId === region.seedId)
    ?? (region.constraint === "exact_track" || region.constraint === "artist" ? region.recordings[0] ?? null : null);
}

function endpointExpectation(region: GradientSeedRecordingRegion | undefined): GradientHardEndpointExpectation {
  if (!region) return { constraint: "region", requestedArtist: null, exactCanonicalKey: null };
  return {
    constraint: region.constraint,
    requestedArtist: region.requestedArtist,
    exactCanonicalKey: region.constraint === "exact_track" && region.requestedArtist && region.requestedTitle
      ? canonicalRadioTrackKey(region.requestedArtist, region.requestedTitle)
      : null,
  };
}

function actualEndpointStatus(plan: GradientRecordingRoutePlan, tracks: StoredGradientTrack[]) {
  return assessGradientMergedEndpoints(
    tracks,
    endpointExpectation(plan.regions[0]),
    endpointExpectation(plan.regions.at(-1)),
  );
}

/** Explicit fallback radio remains fallback, but hard user waypoints still mean what they say. */
function enforceFallbackHardWaypoints(generationId: string, plan: GradientRecordingRoutePlan) {
  const current = getGenerationTracks(generationId);
  if (!current.length) return;
  const output = current.map(copyStored);
  for (const region of plan.regions) {
    if (region.constraint === "region") continue;
    const requested = fallbackWaypointForRegion(plan, region);
    if (!requested) continue;
    const desired = seedTargetIndex(region, output.length);
    const existing = output.findIndex((track) => region.constraint === "exact_track"
      ? track.canonical_key === canonicalRadioTrackKey(requested.artist, requested.title)
      : normalizeForComparison(track.artist) === normalizeForComparison(region.requestedArtist ?? requested.artist));
    const source = existing >= 0 ? output[existing]! : {
      canonical_key: canonicalRadioTrackKey(requested.artist, requested.title),
      artist: requested.artist,
      title: requested.title,
      album: null,
      duration_ms: null,
      isrc: null,
      spotify_id: null,
      navidrome_id: null,
      musicbrainz_id: requested.mbid,
      playback_source: null,
      availability_status: "unknown",
      pinned: 0,
      manual: 0,
      selection_score: 1,
      trajectory_position: null,
      metadata_json: "{}",
    };
    if (existing >= 0 && existing !== desired) [output[existing], output[desired]] = [output[desired]!, source];
    else output[desired] = source;
    const meta = parseObject(output[desired]!.metadata_json);
    output[desired]!.trajectory_position = null;
    output[desired]!.metadata_json = JSON.stringify({
      ...meta,
      gradientWaypoint: true,
      gradientWaypointSeedId: region.seedId,
      gradientWaypointConstraint: region.constraint,
      gradientRouteUnsupported: true,
    });
  }
  replaceGenerationTracks(generationId, output);
}

function finishRecordingGeneration(
  generationId: string,
  plan: GradientRecordingRoutePlan,
  providerDiagnostics: GradientValidatedProviderDiagnostics,
  routeSearchMs: number,
  storedCount: number,
  actualEndpoints: ReturnType<typeof actualEndpointStatus> | null,
  extra: Record<string, unknown> = {},
) {
  const selected = getGenerationTracks(generationId);
  const lengthComplete = storedCount >= plan.requestedLength;
  const plannedEndpointComplete = plan.endpointStatus.startSatisfied && plan.endpointStatus.endSatisfied;
  const finalEndpointComplete = actualEndpoints?.satisfied ?? plannedEndpointComplete;
  const endpointComplete = plannedEndpointComplete && finalEndpointComplete;
  const status = plan.complete && lengthComplete && endpointComplete ? "ready" : "partial";
  finishGeneration(generationId, status, {
    gradient_route: routeDiagnostics(plan, providerDiagnostics),
    gradient_route_candidate_count: plan.recordings.length,
    gradient_route_positioned_count: plan.recordings.filter((row) => row.routePosition != null).length,
    gradient_route_positioned_ratio: plan.recordings.length
      ? plan.recordings.filter((row) => row.routePosition != null).length / plan.recordings.length
      : 0,
    gradient_route_length_complete: lengthComplete,
    gradient_route_requested_length: plan.requestedLength,
    gradient_route_actual_length: storedCount,
    gradient_final_endpoint_status: actualEndpoints ? {
      start_satisfied: actualEndpoints.startSatisfied,
      end_satisfied: actualEndpoints.endSatisfied,
      first_key: actualEndpoints.firstKey,
      last_key: actualEndpoints.lastKey,
    } : null,
    gradient_endpoint_lock_conflict: Boolean(actualEndpoints?.conflict),
    gradient_stage_route_selected: summarizeGradientStage(selected),
    gradient_pipeline_timing: {
      route_search_ms: routeSearchMs,
      route_selection_ms: 0,
      route_materialization_ms: 0,
      pre_finalize_total_ms: routeSearchMs,
    },
    ...extra,
  });
}

async function planForStation(stationId: string, requestedLength: number, tasteProfile: TasteTrack[] = []) {
  const station = getStation(stationId);
  if (!station) throw new Error("Radio station not found");
  const settings = parseRadioSettings(station.settings_json);
  const seeds = getSeeds(stationId);
  const provider = createValidatedGradientRecordingProvider();
  const familiarity = buildGradientFamiliarityScorer(stationId, tasteProfile);
  const started = performance.now();
  const plan = await planGradientRecordingRoute({ seeds, settings, requestedLength, provider, familiarity });
  return { station, settings, seeds, provider, familiarity, plan, routeSearchMs: elapsedMs(started) };
}

export async function generateRadioStationWithRecordingGradient(
  stationId: string,
  input: { length?: number; tasteProfile?: TasteTrack[] } = {},
) {
  const station = getStation(stationId);
  if (!station) throw new Error("Radio station not found");
  const settings = parseRadioSettings(station.settings_json);
  const requestedLength = Math.max(1, Math.min(200, input.length ?? settings.length ?? station.default_length));

  if (station.type !== "gradient" || settings.gradientAlgorithm === "blend") {
    return generateStation(stationId, input);
  }

  const planned = await planForStation(stationId, requestedLength, input.tasteProfile ?? []);
  const providerDiagnostics = planned.provider.diagnostics();
  if (planned.plan.state === "no_route") {
    const fallback = await generateStation(stationId, input);
    enforceFallbackHardWaypoints(fallback.id, planned.plan);
    const generation = getGeneration(fallback.id)!;
    const previous = parseObject(generation.diagnostics_json);
    finishGeneration(fallback.id, "partial", {
      ...previous,
      gradient_route: routeDiagnostics(planned.plan, providerDiagnostics),
      gradient_fallback_radio: true,
      gradient_fallback_reason: "No valid recording-level musical bridge was found; this is fallback radio.",
      gradient_stage_route_selected: summarizeGradientStage(getGenerationTracks(fallback.id)),
      gradient_pipeline_timing: {
        route_search_ms: planned.routeSearchMs,
        pre_finalize_total_ms: planned.routeSearchMs,
      },
    });
    return presentGeneration(fallback.id)!;
  }

  const generation = createGeneration({
    stationId,
    requestedLength,
    generatorVersion: `radio-v5-gradient-recording-${settings.gradientAlgorithm}`,
    randomSeed: crypto.randomUUID(),
    settingsSnapshot: { ...settings, length: requestedLength },
  });
  const stored = storedRouteTracks(planned.plan, planned.familiarity);
  replaceGenerationTracks(generation.id, stored);
  finishRecordingGeneration(
    generation.id,
    planned.plan,
    providerDiagnostics,
    planned.routeSearchMs,
    stored.length,
    actualEndpointStatus(planned.plan, stored),
    { gradient_fallback_radio: false },
  );
  return presentGeneration(generation.id)!;
}

export async function regenerateRadioTailWithRecordingGradient(
  generationId: string,
  fromPosition: number,
  tasteProfile: TasteTrack[] = [],
) {
  const generation = getGeneration(generationId);
  if (!generation) throw new Error("Radio generation not found");
  const station = getStation(generation.station_id);
  if (!station) throw new Error("Radio station not found");
  const settings = parseRadioSettings(generation.settings_snapshot_json);
  if (station.type !== "gradient" || settings.gradientAlgorithm === "blend") {
    return regenerateTail(generationId, fromPosition, tasteProfile);
  }

  const existing = getGenerationTracks(generationId);
  const planned = await planForStation(station.id, generation.requested_length, tasteProfile);
  const providerDiagnostics = planned.provider.diagnostics();
  if (planned.plan.state === "no_route") {
    const fallback = await regenerateTail(generationId, fromPosition, tasteProfile);
    enforceFallbackHardWaypoints(generationId, planned.plan);
    finishGeneration(generationId, "partial", {
      ...(fallback.diagnostics ?? {}),
      gradient_route: routeDiagnostics(planned.plan, providerDiagnostics),
      gradient_fallback_radio: true,
      gradient_fallback_reason: "No valid recording-level musical bridge was found; regenerated tail is fallback radio.",
      gradient_pipeline_timing: { route_search_ms: planned.routeSearchMs, pre_finalize_total_ms: planned.routeSearchMs },
    });
    return presentGeneration(generationId)!;
  }

  const routeTracks = storedRouteTracks(planned.plan, planned.familiarity);
  const merged = mergeGradientPlannedTail(existing, routeTracks, generation.requested_length, Math.max(0, fromPosition));
  replaceGenerationTracks(generationId, merged);
  getDb().query("UPDATE radio_generations SET generator_version=? WHERE id=?")
    .run(`radio-v5-gradient-recording-${settings.gradientAlgorithm}`, generationId);
  const endpoints = actualEndpointStatus(planned.plan, merged);
  finishRecordingGeneration(
    generationId,
    planned.plan,
    providerDiagnostics,
    planned.routeSearchMs,
    merged.length,
    endpoints,
    {
      gradient_fallback_radio: false,
      gradient_regenerated_from: Math.max(0, fromPosition),
      ...(endpoints.conflict ? { gradient_endpoint_lock_conflict_reason: "locked_track_prevented_hard_endpoint" } : {}),
    },
  );
  return presentGeneration(generationId)!;
}
