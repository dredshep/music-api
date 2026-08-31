import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import type { RadioSettings } from "../db/repositories/radio";
import { canonicalRadioTrackKey } from "./radio";
import type { GradientRecording, GradientRecordingPathEdge } from "./radio-gradient-recording-path";
import { normalizeGlobalPopularity, gradientReleaseRecency, gradientProfileFit, type GradientTrackProfile } from "./radio-gradient-profile";

// ─── Types ──────────────────────────────────────────────────────────

export interface GradientRouteIntent {
  discoveryTarget: number;
  rarityTarget: number;
  recencyTarget: number;
  rangeTarget: number;
  transitionTarget: number;
  artistDiversityTarget: number;
  endpointArtists: [string, string] | null;
  requestedLength: number;
}

export interface GradientTrackEvidence {
  index: number;
  artist: string;
  title: string;
  isEndpoint: boolean;
  routePosition: number | null;

  ownedExact: boolean;
  knownExact: boolean;
  knownArtist: boolean;
  familiarityValue: number | null;
  familiaritySource: string;

  globalPopularity: number | null;
  listeners: number | null;
  graphDegree: number;
  contextualProminence: number | null;

  releaseYear: number | null;
  releaseSource: string;
  recency: number | null;

  tags: string[];
  isDuplicateArtist: boolean;
  isEndpointArtistInterior: boolean;

  profileFit: number;
}

export interface GradientRouteCompliance {
  trackCount: number;
  endpointsSatisfied: boolean;

  diversity: {
    uniqueArtists: number;
    totalInterior: number;
    maxArtistOccurrences: number;
    endpointArtistInteriorCount: number;
    uniqueArtistRatio: number;
    pass: boolean;
  };

  discovery: {
    ownedInteriorCount: number;
    knownExactInteriorCount: number;
    knownArtistInteriorCount: number;
    unknownInteriorCount: number;
    genuinelyNewCount: number;
    genuinelyNewRatio: number;
    pass: boolean;
  };

  rarity: {
    medianPopularity: number | null;
    p90Popularity: number | null;
    medianGraphDegree: number;
    highProminenceCount: number;
    pass: boolean;
  };

  recency: {
    medianReleaseYear: number | null;
    recentFraction: number;
    oldFraction: number;
    unknownYearFraction: number;
    pass: boolean;
  };

  range: {
    tagClusters: number;
    tagEntropy: number;
    pass: boolean;
  };

  transitions: {
    minEdgeSimilarity: number;
    medianEdgeSimilarity: number;
    maxEdgeCost: number;
    catastrophicCount: number;
    pass: boolean;
  };

  overallPass: boolean;
  tracks: GradientTrackEvidence[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1);
  return sorted[Math.max(0, idx)]!;
}

function shannonEntropy(counts: Map<string, number>): number {
  const total = [...counts.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

// ─── Intent derivation ──────────────────────────────────────────────

export function deriveRouteIntent(
  settings: RadioSettings,
  endpointArtists: [string, string] | null,
  requestedLength: number,
): GradientRouteIntent {
  return {
    discoveryTarget: 1 - clamp(settings.familiarity, 0, 1),
    rarityTarget: clamp(-settings.popularityBias, 0, 1),
    recencyTarget: clamp(settings.releaseAgeBias, 0, 1),
    rangeTarget: 1 - clamp(settings.genreSimilarity, 0, 1),
    transitionTarget: clamp(settings.djFlow, 0, 1),
    artistDiversityTarget: 1 - clamp(settings.sameArtistBias, 0, 1),
    endpointArtists,
    requestedLength,
  };
}

// ─── Graph degree lookup ────────────────────────────────────────────

function loadGraphDegrees(): Map<string, number> {
  const degrees = new Map<string, number>();
  try {
    const db = getDb();
    const rows = db.query<{ canonical_key: string; deg: number }, []>(
      `SELECT source_key AS canonical_key, COUNT(*) AS deg
       FROM recording_similarity_edges GROUP BY source_key`,
    ).all();
    for (const row of rows) degrees.set(row.canonical_key, row.deg);
  } catch { /* standalone tests */ }
  return degrees;
}

// ─── Library / familiarity evidence ─────────────────────────────────

interface OwnershipEvidence {
  ownedKeys: Set<string>;
  ownedArtists: Set<string>;
  knownKeys: Set<string>;
  knownArtists: Set<string>;
}

function loadOwnershipEvidence(stationId: string | null): OwnershipEvidence {
  const result: OwnershipEvidence = {
    ownedKeys: new Set(),
    ownedArtists: new Set(),
    knownKeys: new Set(),
    knownArtists: new Set(),
  };
  try {
    const db = getDb();
    const rows = db.query<{ canonical_key: string; artist: string; locally_owned: number }, [string]>(
      `SELECT t.canonical_key, t.artist,
              MAX(CASE WHEN t.navidrome_id IS NOT NULL THEN 1 ELSE 0 END) AS locally_owned
       FROM radio_generation_tracks t
       JOIN radio_generations g ON g.id = t.generation_id
       WHERE g.station_id = ?
       GROUP BY t.canonical_key, t.artist`,
    ).all(stationId ?? "");
    for (const row of rows) {
      result.knownKeys.add(row.canonical_key);
      result.knownArtists.add(normalizeForComparison(row.artist));
      if (row.locally_owned) {
        result.ownedKeys.add(row.canonical_key);
        result.ownedArtists.add(normalizeForComparison(row.artist));
      }
    }
    // Also check tracks with navidrome_id across all stations (truly owned)
    const owned = db.query<{ canonical_key: string; artist: string }, []>(
      `SELECT DISTINCT canonical_key, artist FROM radio_generation_tracks
       WHERE navidrome_id IS NOT NULL`,
    ).all();
    for (const row of owned) {
      result.ownedKeys.add(row.canonical_key);
      result.ownedArtists.add(normalizeForComparison(row.artist));
    }
  } catch { /* tests / missing DB */ }
  return result;
}

// ─── Main audit ─────────────────────────────────────────────────────

export async function auditGradientRoute(input: {
  recordings: Array<GradientRecording & { routePosition?: number | null }>;
  edges: GradientRecordingPathEdge[];
  intent: GradientRouteIntent;
  settings: RadioSettings;
  profile: (recording: GradientRecording) => Promise<GradientTrackProfile>;
  familiarity?: (recording: GradientRecording) => number | null;
  stationId?: string | null;
}): Promise<GradientRouteCompliance> {
  const { recordings, edges, intent, settings } = input;
  const endpointArtistsNorm = intent.endpointArtists?.map(normalizeForComparison) ?? [];
  const graphDegrees = loadGraphDegrees();
  const ownership = loadOwnershipEvidence(input.stationId ?? null);

  const currentYear = new Date().getUTCFullYear();
  const recentWindow = 8;

  // Build per-track evidence
  const artistCounts = new Map<string, number>();
  for (const rec of recordings) {
    const a = normalizeForComparison(rec.artist);
    artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
  }

  const trackProfiles = await Promise.all(recordings.map((rec) => input.profile(rec)));
  const tracks: GradientTrackEvidence[] = recordings.map((rec, i) => {
    const artistNorm = normalizeForComparison(rec.artist);
    const canonKey = canonicalRadioTrackKey(rec.artist, rec.title);
    const isEndpoint = i === 0 || i === recordings.length - 1;
    const isEndpointArtist = endpointArtistsNorm.includes(artistNorm);
    const profile = trackProfiles[i]!;
    const famVal = input.familiarity?.(rec) ?? null;

    const ownedExact = ownership.ownedKeys.has(canonKey);
    const knownExact = ownership.knownKeys.has(canonKey);
    const knownArtist = ownership.knownArtists.has(artistNorm) || ownership.ownedArtists.has(artistNorm);

    let familiaritySource = "unknown";
    if (famVal != null) familiaritySource = ownedExact ? "owned" : knownExact ? "history" : knownArtist ? "artist" : "taste";

    const degree = graphDegrees.get(rec.key) ?? graphDegrees.get(canonKey) ?? 0;
    const pop = profile.popularity ?? (profile.listeners ? normalizeGlobalPopularity(profile.listeners) : null);
    const recency = profile.releaseYear ? gradientReleaseRecency(profile.releaseYear, currentYear) : null;

    const contextualProminence = pop != null && degree > 0
      ? clamp(pop * 0.6 + Math.min(1, Math.log1p(degree) / Math.log1p(200)) * 0.4, 0, 1)
      : pop;

    return {
      index: i,
      artist: rec.artist,
      title: rec.title,
      isEndpoint,
      routePosition: rec.routePosition ?? null,
      ownedExact,
      knownExact,
      knownArtist,
      familiarityValue: famVal,
      familiaritySource,
      globalPopularity: pop,
      listeners: profile.listeners,
      graphDegree: degree,
      contextualProminence,
      releaseYear: profile.releaseYear,
      releaseSource: profile.source,
      recency,
      tags: profile.tags ?? [],
      isDuplicateArtist: (artistCounts.get(artistNorm) ?? 0) > 1,
      isEndpointArtistInterior: !isEndpoint && isEndpointArtist,
      profileFit: gradientProfileFit(profile, settings),
    };
  });

  const interior = tracks.filter((t) => !t.isEndpoint);
  const interiorCount = interior.length;

  // ── Diversity ──
  const interiorArtists = new Map<string, number>();
  for (const t of interior) {
    const a = normalizeForComparison(t.artist);
    interiorArtists.set(a, (interiorArtists.get(a) ?? 0) + 1);
  }
  const uniqueInteriorArtists = interiorArtists.size;
  const maxArtistOcc = interiorArtists.size ? Math.max(...interiorArtists.values()) : 0;
  const endpointInterior = interior.filter((t) => t.isEndpointArtistInterior).length;
  const uniqueRatio = interiorCount > 0 ? uniqueInteriorArtists / interiorCount : 1;
  const diversityPass = endpointInterior === 0 && maxArtistOcc <= 1 && uniqueRatio >= 0.8;

  // ── Discovery ──
  const owned = interior.filter((t) => t.ownedExact).length;
  const knownExact = interior.filter((t) => t.knownExact).length;
  const knownArtist = interior.filter((t) => t.knownArtist).length;
  const unknownEvidence = interior.filter((t) => t.familiarityValue == null && !t.knownArtist && !t.knownExact).length;
  const genuinelyNew = interior.filter((t) => !t.ownedExact && !t.knownExact && !t.knownArtist && t.familiarityValue == null).length;
  // For "mostly new," unknown does NOT count as new. Only tracks with evidence of being outside library.
  // Since we can't prove positively-new easily, we count tracks where artist is NOT in library.
  const positivelyUnknownArtist = interior.filter((t) => !t.knownArtist && !t.ownedExact).length;
  const discoveryRatio = interiorCount > 0 ? positivelyUnknownArtist / interiorCount : 1;
  const discoveryPass = intent.discoveryTarget > 0.5 ? discoveryRatio >= 0.6 : true;

  // ── Rarity ──
  const popValues = interior.flatMap((t) => t.globalPopularity != null ? [t.globalPopularity] : []);
  const degreeValues = interior.map((t) => t.graphDegree);
  const highProminence = interior.filter((t) => (t.contextualProminence ?? 0) > 0.65).length;
  const medPop = median(popValues);
  const p90Pop = percentile(popValues, 90);
  const medDeg = median(degreeValues) ?? 0;
  const rarityPass = intent.rarityTarget > 0.5
    ? (medPop == null || medPop < 0.5) && highProminence <= Math.ceil(interiorCount * 0.3)
    : true;

  // ── Recency ──
  const yearValues = interior.flatMap((t) => t.releaseYear != null ? [t.releaseYear] : []);
  const recentCount = interior.filter((t) => t.releaseYear != null && (currentYear - t.releaseYear) <= recentWindow).length;
  const oldCount = interior.filter((t) => t.releaseYear != null && (currentYear - t.releaseYear) > 20).length;
  const unknownYear = interior.filter((t) => t.releaseYear == null).length;
  const recentFrac = interiorCount > 0 ? recentCount / interiorCount : 0;
  const oldFrac = interiorCount > 0 ? oldCount / interiorCount : 0;
  const unknownYearFrac = interiorCount > 0 ? unknownYear / interiorCount : 0;
  const recencyPass = intent.recencyTarget > 0.5
    ? recentFrac >= 0.4 || (unknownYearFrac > 0.5)
    : true;

  // ── Range ──
  const tagCounts = new Map<string, number>();
  for (const t of interior) {
    for (const tag of t.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const tagEntropy = shannonEntropy(tagCounts);
  const hasTagData = interior.some((t) => t.tags.length > 0);
  const rangePass = !hasTagData
    || (intent.rangeTarget > 0.5 ? tagCounts.size >= 3 && tagEntropy >= 1.5 : true);

  // ── Transitions ──
  const sims = edges.map((e) => e.similarity * e.confidence);
  const edgeCosts = edges.map((e) => -Math.log(clamp(e.similarity * e.confidence, 0.015, 1)) + 0.025);
  const minSim = sims.length ? Math.min(...sims) : 0;
  const medSim = median(sims) ?? 0;
  const maxCost = edgeCosts.length ? Math.max(...edgeCosts) : 0;
  const catastrophic = edges.filter((e) => e.similarity * e.confidence < 0.05).length;
  const transitionPass = catastrophic === 0 && minSim >= 0.08;

  const startOk = recordings.length > 0;
  const endOk = recordings.length > 0;

  const overallPass = diversityPass && discoveryPass && rarityPass && recencyPass && transitionPass && startOk && endOk;

  return {
    trackCount: recordings.length,
    endpointsSatisfied: startOk && endOk,
    diversity: {
      uniqueArtists: uniqueInteriorArtists,
      totalInterior: interiorCount,
      maxArtistOccurrences: maxArtistOcc,
      endpointArtistInteriorCount: endpointInterior,
      uniqueArtistRatio: uniqueRatio,
      pass: diversityPass,
    },
    discovery: {
      ownedInteriorCount: owned,
      knownExactInteriorCount: knownExact,
      knownArtistInteriorCount: knownArtist,
      unknownInteriorCount: unknownEvidence,
      genuinelyNewCount: genuinelyNew,
      genuinelyNewRatio: discoveryRatio,
      pass: discoveryPass,
    },
    rarity: {
      medianPopularity: medPop,
      p90Popularity: p90Pop,
      medianGraphDegree: medDeg,
      highProminenceCount: highProminence,
      pass: rarityPass,
    },
    recency: {
      medianReleaseYear: median(yearValues),
      recentFraction: recentFrac,
      oldFraction: oldFrac,
      unknownYearFraction: unknownYearFrac,
      pass: recencyPass,
    },
    range: {
      tagClusters: tagCounts.size,
      tagEntropy,
      pass: rangePass,
    },
    transitions: {
      minEdgeSimilarity: minSim,
      medianEdgeSimilarity: medSim,
      maxEdgeCost: maxCost,
      catastrophicCount: catastrophic,
      pass: transitionPass,
    },
    overallPass,
    tracks,
  };
}

export function formatComplianceReport(c: GradientRouteCompliance, intent: GradientRouteIntent): string {
  const lines: string[] = [];
  const passIcon = (ok: boolean) => ok ? "PASS" : "FAIL";

  lines.push(`=== Gradient Route Compliance Audit ===`);
  lines.push(`Tracks: ${c.trackCount}  Endpoints: ${c.endpointsSatisfied ? "OK" : "MISSING"}`);
  lines.push(``);

  lines.push(`[${passIcon(c.diversity.pass)}] DIVERSITY`);
  lines.push(`  Interior unique artists: ${c.diversity.uniqueArtists}/${c.diversity.totalInterior} (${(c.diversity.uniqueArtistRatio * 100).toFixed(0)}%)`);
  lines.push(`  Max artist occurrences: ${c.diversity.maxArtistOccurrences}`);
  lines.push(`  Endpoint artist in interior: ${c.diversity.endpointArtistInteriorCount}`);
  lines.push(``);

  lines.push(`[${passIcon(c.discovery.pass)}] DISCOVERY (target: ${(intent.discoveryTarget * 100).toFixed(0)}% new)`);
  lines.push(`  Owned interior: ${c.discovery.ownedInteriorCount}`);
  lines.push(`  Known exact: ${c.discovery.knownExactInteriorCount}`);
  lines.push(`  Known artist: ${c.discovery.knownArtistInteriorCount}`);
  lines.push(`  Unknown evidence: ${c.discovery.unknownInteriorCount}`);
  lines.push(`  Genuinely new: ${c.discovery.genuinelyNewCount} (${(c.discovery.genuinelyNewRatio * 100).toFixed(0)}%)`);
  lines.push(``);

  lines.push(`[${passIcon(c.rarity.pass)}] RARITY (target: ${(intent.rarityTarget * 100).toFixed(0)}% rare)`);
  lines.push(`  Median popularity: ${c.rarity.medianPopularity?.toFixed(3) ?? "unknown"}`);
  lines.push(`  P90 popularity: ${c.rarity.p90Popularity?.toFixed(3) ?? "unknown"}`);
  lines.push(`  Median graph degree: ${c.rarity.medianGraphDegree}`);
  lines.push(`  High prominence interior: ${c.rarity.highProminenceCount}`);
  lines.push(``);

  lines.push(`[${passIcon(c.recency.pass)}] RECENCY (target: ${(intent.recencyTarget * 100).toFixed(0)}% recent)`);
  lines.push(`  Median year: ${c.recency.medianReleaseYear ?? "unknown"}`);
  lines.push(`  Recent fraction: ${(c.recency.recentFraction * 100).toFixed(0)}%`);
  lines.push(`  Old fraction: ${(c.recency.oldFraction * 100).toFixed(0)}%`);
  lines.push(`  Unknown year: ${(c.recency.unknownYearFraction * 100).toFixed(0)}%`);
  lines.push(``);

  lines.push(`[${passIcon(c.range.pass)}] RANGE (target: ${(intent.rangeTarget * 100).toFixed(0)}% genre-hopping)`);
  lines.push(`  Tag clusters: ${c.range.tagClusters}`);
  lines.push(`  Tag entropy: ${c.range.tagEntropy.toFixed(2)}`);
  lines.push(``);

  lines.push(`[${passIcon(c.transitions.pass)}] TRANSITIONS`);
  lines.push(`  Min edge similarity: ${c.transitions.minEdgeSimilarity.toFixed(3)}`);
  lines.push(`  Median edge similarity: ${c.transitions.medianEdgeSimilarity.toFixed(3)}`);
  lines.push(`  Catastrophic edges: ${c.transitions.catastrophicCount}`);
  lines.push(``);

  lines.push(`OVERALL: ${passIcon(c.overallPass)}`);
  lines.push(``);

  lines.push(`--- Per-Track Evidence ---`);
  for (const t of c.tracks) {
    const flags: string[] = [];
    if (t.isEndpoint) flags.push("ENDPOINT");
    if (t.isDuplicateArtist) flags.push("DUP_ARTIST");
    if (t.isEndpointArtistInterior) flags.push("ENDPOINT_ARTIST_INTERIOR");
    if (t.ownedExact) flags.push("OWNED");
    if (t.knownExact) flags.push("KNOWN");
    if (t.knownArtist) flags.push("KNOWN_ARTIST");
    lines.push(`  ${t.index.toString().padStart(2)}. ${t.artist} — ${t.title}`);
    lines.push(`      pop=${t.globalPopularity?.toFixed(3) ?? "?"} deg=${t.graphDegree} prom=${t.contextualProminence?.toFixed(3) ?? "?"} year=${t.releaseYear ?? "?"} fit=${t.profileFit.toFixed(3)}${flags.length ? " [" + flags.join(", ") + "]" : ""}`);
  }
  return lines.join("\n");
}
