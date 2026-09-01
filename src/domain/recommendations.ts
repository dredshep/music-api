import { getConfig } from "../config";
import { log } from "../middleware/logging";
import * as lastfm from "../services/lastfm";
import * as listenbrainz from "../services/listenbrainz";
import * as navidrome from "../services/navidrome";
import {
  getCatalogArtist,
  getReleaseGroupsForArtist,
  isCatalogStale,
} from "../db/repositories/catalog";
import {
  createGeneration,
  updateGeneration,
  createCandidate,
  createEvidence,
  upsertRecommendation,
  getRecentlyRecommendedMbids,
  type RecommendationType,
  type RecommendationSource,
  type RecommendationReason,
  type NavidromeMatchStatus,
} from "../db/repositories/recommendations";
import { normalizeForComparison } from "./normalization";
import type { LastFmPeriod } from "../services/lastfm";

// --- Seed types ---

export interface Seed {
  name: string;
  mbid: string;
  affinity: number;
  windows: Partial<Record<LastFmPeriod, number>>;
}

// --- Observation (pre-canonicalization) ---

export interface SourceObservation {
  source: RecommendationSource;
  reason: RecommendationReason;
  artistName: string;
  artistMbid: string;
  releaseGroupMbid?: string;
  releaseTitle?: string;
  firstReleaseDate?: string;
  sourceScore: number;
  seedArtistName: string;
  seedArtistMbid: string;
  seedAffinity: number;
  recordingMbid?: string;
  metadata?: Record<string, unknown>;
}

// --- Canonical candidate (post-merge) ---

export interface CanonicalCandidate {
  type: RecommendationType;
  artistMbid: string | null;
  releaseGroupMbid: string | null;
  artistName: string;
  releaseTitle: string | null;
  firstReleaseDate: string | null;
  navidromeMatchStatus: NavidromeMatchStatus | "unchecked";
  navidromeMatchConfidence: number;
  evidence: SourceObservation[];
  score: number;
  scoreBreakdown: Record<string, number>;
  primaryReason: RecommendationReason;
}

// --- Generation pipeline ---

export interface GenerateOptions {
  limit?: number;
  sources?: RecommendationSource[];
  includePossibleMatch?: boolean;
}

export interface GenerationResult {
  generationId: string;
  status: "completed" | "partial" | "failed";
  selected: number;
  stats: GenerationStats;
}

export interface GenerationStats {
  seedCount: number;
  observationCount: number;
  canonicalCount: number;
  navidromeMatchedCount: number;
  eligibleCount: number;
  selectedCount: number;
  errorCount: number;
  sources: Record<string, { observations: number; errors: number }>;
  duration_ms: number;
}

export async function runGeneration(options: GenerateOptions = {}): Promise<GenerationResult> {
  const config = getConfig();
  const startTime = performance.now();
  const limit = options.limit ?? config.RECOMMENDATION_DEFAULT_LIMIT;
  const activeSources = options.sources ?? [
    "lastfm_similar",
    "listenbrainz_cf",
    "musicbrainz_new_release",
  ];

  const generation = createGeneration(JSON.stringify({ limit, sources: activeSources }));
  const sourceStats: Record<string, { observations: number; errors: number }> = {};
  const errors: Array<{ source: string; error: string }> = [];

  try {
    // 1. Build seeds from Last.fm top artists
    const seeds = await buildSeeds();
    updateGeneration(generation.id, { seed_count: seeds.length });

    // 2. Generate observations from each source
    const observations: SourceObservation[] = [];

    if (activeSources.includes("lastfm_similar")) {
      try {
        const obs = await generateLastFmSimilar(seeds);
        observations.push(...obs);
        sourceStats["lastfm_similar"] = { observations: obs.length, errors: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ source: "lastfm_similar", error: msg });
        sourceStats["lastfm_similar"] = { observations: 0, errors: 1 };
        log("warn", "rec_source_failed", { source: "lastfm_similar", error: msg });
      }
    }

    if (activeSources.includes("listenbrainz_cf") && listenbrainz.isConfigured()) {
      try {
        const obs = await generateListenBrainzCF(seeds);
        observations.push(...obs);
        sourceStats["listenbrainz_cf"] = { observations: obs.length, errors: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ source: "listenbrainz_cf", error: msg });
        sourceStats["listenbrainz_cf"] = { observations: 0, errors: 1 };
        log("warn", "rec_source_failed", { source: "listenbrainz_cf", error: msg });
      }
    }

    if (activeSources.includes("musicbrainz_new_release")) {
      try {
        const obs = await generateNewReleases(seeds);
        observations.push(...obs);
        sourceStats["musicbrainz_new_release"] = { observations: obs.length, errors: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ source: "musicbrainz_new_release", error: msg });
        sourceStats["musicbrainz_new_release"] = { observations: 0, errors: 1 };
        log("warn", "rec_source_failed", { source: "musicbrainz_new_release", error: msg });
      }
    }

    updateGeneration(generation.id, { observation_count: observations.length });

    // 3. Canonicalize + merge
    const canonical = mergeObservations(observations);
    updateGeneration(generation.id, { canonical_candidate_count: canonical.length });

    // 4. Navidrome match resolution
    const withNavidromeMatches = await resolveNavidromeMatches(canonical);
    const navidromeMatchedCount = withNavidromeMatches.filter((c) => c.navidromeMatchStatus === "matched").length;

    // 5. Filter eligible
    const eligible = withNavidromeMatches.filter((c) => {
      if (c.navidromeMatchStatus === "matched") return false;
      if (c.navidromeMatchStatus === "possible_match" && !options.includePossibleMatch) return false;
      return true;
    });

    updateGeneration(generation.id, { eligible_candidate_count: eligible.length });

    // 6. Score
    const scored = eligible.map((c) => scoreCandidate(c));
    scored.sort((a, b) => b.score - a.score);

    // 7. Diversity + selection
    const selected = applyDiversity(scored, limit);
    updateGeneration(generation.id, { selected_count: selected.length });

    // 8. Persist candidates + evidence + upsert recommendations
    for (const candidate of scored) {
      const isSelected = selected.includes(candidate);
      const candidateId = createCandidate({
        generationId: generation.id,
        type: candidate.type,
        artistMbid: candidate.artistMbid,
        releaseGroupMbid: candidate.releaseGroupMbid,
        artistName: candidate.artistName,
        releaseTitle: candidate.releaseTitle,
        firstReleaseDate: candidate.firstReleaseDate,
        navidromeMatchStatus: candidate.navidromeMatchStatus,
        navidromeMatchConfidence: candidate.navidromeMatchConfidence,
        score: candidate.score,
        scoreBreakdown: candidate.scoreBreakdown,
        primaryReason: candidate.primaryReason,
        selected: isSelected,
      });

      for (const ev of candidate.evidence) {
        createEvidence({
          candidateId,
          source: ev.source,
          reason: ev.reason,
          sourceScore: ev.sourceScore,
          seedArtistMbid: ev.seedArtistMbid || null,
          seedArtistName: ev.seedArtistName || null,
          seedAffinity: ev.seedAffinity,
          recordingMbid: ev.recordingMbid ?? null,
          metadata: ev.metadata ?? null,
        });
      }

      if (isSelected) {
        upsertRecommendation({
          type: candidate.type,
          artistMbid: candidate.artistMbid,
          releaseGroupMbid: candidate.releaseGroupMbid,
          artistName: candidate.artistName,
          releaseTitle: candidate.releaseTitle,
          firstReleaseDate: candidate.firstReleaseDate,
          score: candidate.score,
          scoreBreakdown: candidate.scoreBreakdown,
          primaryReason: candidate.primaryReason,
          navidromeMatchStatus: candidate.navidromeMatchStatus,
        });
      }
    }

    const status = errors.length > 0 ? "partial" : "completed";
    const duration = Math.round(performance.now() - startTime);

    const stats: GenerationStats = {
      seedCount: seeds.length,
      observationCount: observations.length,
      canonicalCount: canonical.length,
      navidromeMatchedCount,
      eligibleCount: eligible.length,
      selectedCount: selected.length,
      errorCount: errors.length,
      sources: sourceStats,
      duration_ms: duration,
    };

    updateGeneration(generation.id, {
      status,
      completed_at: new Date().toISOString(),
      error_count: errors.length,
      stats_json: JSON.stringify(stats),
      error_json: errors.length > 0 ? JSON.stringify(errors) : null,
    });

    log("info", "recommendation_generation_complete", {
      generation_id: generation.id,
      status,
      seeds: seeds.length,
      observations: observations.length,
      eligible: eligible.length,
      selected: selected.length,
      duration_ms: duration,
    });

    return { generationId: generation.id, status, selected: selected.length, stats };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateGeneration(generation.id, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_json: JSON.stringify([{ source: "pipeline", error: msg }]),
    });
    log("error", "recommendation_generation_failed", { generation_id: generation.id, error: msg });
    return {
      generationId: generation.id,
      status: "failed",
      selected: 0,
      stats: {
        seedCount: 0,
        observationCount: 0,
        canonicalCount: 0,
        navidromeMatchedCount: 0,
        eligibleCount: 0,
        selectedCount: 0,
        errorCount: 1,
        sources: sourceStats,
        duration_ms: Math.round(performance.now() - startTime),
      },
    };
  }
}

// --- Step 1: Build seeds ---

const WINDOW_WEIGHTS: Record<LastFmPeriod, number> = {
  "7day": 0.25,
  "1month": 0.30,
  "3month": 0,
  "6month": 0.25,
  "12month": 0,
  "overall": 0.20,
};

const SEED_WINDOWS: LastFmPeriod[] = ["7day", "1month", "6month", "overall"];

export async function buildSeeds(): Promise<Seed[]> {
  const config = getConfig();
  const perWindow = config.RECOMMENDATION_SEEDS_PER_WINDOW;
  const maxSeeds = config.RECOMMENDATION_MAX_SEEDS;

  const seedMap = new Map<string, Seed>();

  for (const period of SEED_WINDOWS) {
    const artists = await lastfm.getTopArtists(period, perWindow);

    for (const artist of artists) {
      const key = artist.mbid || normalizeForComparison(artist.name);
      const count = artists.length;
      const rankScore = 1 - (artist.rank - 1) / Math.max(1, count - 1);
      const windowWeight = WINDOW_WEIGHTS[period];
      const contribution = rankScore * windowWeight;

      const existing = seedMap.get(key);
      if (existing) {
        existing.affinity += contribution;
        existing.windows[period] = rankScore;
        if (artist.mbid && !existing.mbid) existing.mbid = artist.mbid;
      } else {
        seedMap.set(key, {
          name: artist.name,
          mbid: artist.mbid,
          affinity: contribution,
          windows: { [period]: rankScore },
        });
      }
    }
  }

  const seeds = Array.from(seedMap.values());
  seeds.sort((a, b) => b.affinity - a.affinity);

  const maxAffinity = seeds[0]?.affinity ?? 1;
  for (const seed of seeds) {
    seed.affinity = Math.min(1.0, seed.affinity / Math.max(0.01, maxAffinity));
  }

  return seeds.slice(0, maxSeeds);
}

// --- Step 2a: Last.fm similar artists ---

async function generateLastFmSimilar(seeds: Seed[]): Promise<SourceObservation[]> {
  const config = getConfig();
  const perSeed = config.RECOMMENDATION_SIMILAR_PER_SEED;
  const observations: SourceObservation[] = [];

  for (const seed of seeds) {
    try {
      const similar = await lastfm.getSimilarArtists(seed.name, perSeed);

      const isRecent = (seed.windows["7day"] ?? 0) > 0.3 || (seed.windows["1month"] ?? 0) > 0.3;
      const reason: RecommendationReason = isRecent ? "similar_to_recent" : "similar_to_favorite";

      for (const artist of similar) {
        observations.push({
          source: "lastfm_similar",
          reason,
          artistName: artist.name,
          artistMbid: artist.mbid,
          sourceScore: artist.match,
          seedArtistName: seed.name,
          seedArtistMbid: seed.mbid,
          seedAffinity: seed.affinity,
        });
      }
    } catch (err) {
      log("warn", "rec_similar_seed_failed", {
        seed: seed.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return observations;
}

// --- Step 2b: ListenBrainz collaborative filtering ---

async function generateListenBrainzCF(_seeds: Seed[]): Promise<SourceObservation[]> {
  const recs = await listenbrainz.getRecommendations(200);
  if (recs.length === 0) return [];

  const observations: SourceObservation[] = [];

  for (const rec of recs) {
    observations.push({
      source: "listenbrainz_cf",
      reason: "collaborative",
      artistName: "",
      artistMbid: "",
      recordingMbid: rec.recordingMbid,
      sourceScore: Math.min(1.0, rec.score / 10),
      seedArtistName: "",
      seedArtistMbid: "",
      seedAffinity: 0.5,
    });
  }

  return observations;
}

// --- Step 2c: New releases from favorites ---

async function generateNewReleases(seeds: Seed[]): Promise<SourceObservation[]> {
  const config = getConfig();
  const horizonMs = config.RECOMMENDATION_NEW_RELEASE_DAYS * 24 * 60 * 60 * 1000;
  const horizonDate = new Date(Date.now() - horizonMs);
  const observations: SourceObservation[] = [];

  const highAffinitySeeds = seeds.filter((s) => s.affinity >= 0.3 && s.mbid);

  for (const seed of highAffinitySeeds.slice(0, 30)) {
    const catalogArtist = getCatalogArtist(seed.mbid);
    if (!catalogArtist) continue;
    if (isCatalogStale(catalogArtist, config.ARTIST_CACHE_DAYS)) continue;

    const groups = getReleaseGroupsForArtist(seed.mbid);
    const eligible = groups.filter((rg) => {
      if (!rg.first_release_date) return false;
      const releaseDate = new Date(rg.first_release_date);
      if (releaseDate < horizonDate) return false;
      const primaryType = rg.primary_type?.toLowerCase();
      return primaryType === "album" || primaryType === "ep";
    });

    for (const rg of eligible) {
      observations.push({
        source: "musicbrainz_new_release",
        reason: "new_release",
        artistName: catalogArtist.name,
        artistMbid: seed.mbid,
        releaseGroupMbid: rg.mbid,
        releaseTitle: rg.title,
        firstReleaseDate: rg.first_release_date ?? undefined,
        sourceScore: 0.8,
        seedArtistName: seed.name,
        seedArtistMbid: seed.mbid,
        seedAffinity: seed.affinity,
      });
    }
  }

  return observations;
}

// --- Step 3: Merge observations by canonical identity ---

function mergeObservations(observations: SourceObservation[]): CanonicalCandidate[] {
  const byKey = new Map<string, CanonicalCandidate>();

  for (const obs of observations) {
    const key = obs.releaseGroupMbid
      ? `rg:${obs.releaseGroupMbid}`
      : obs.artistMbid
        ? `artist:${obs.artistMbid}`
        : `name:${normalizeForComparison(obs.artistName)}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.evidence.push(obs);
      if (obs.releaseTitle && !existing.releaseTitle) {
        existing.releaseTitle = obs.releaseTitle;
      }
      if (obs.firstReleaseDate && !existing.firstReleaseDate) {
        existing.firstReleaseDate = obs.firstReleaseDate;
      }
    } else {
      byKey.set(key, {
        type: obs.releaseGroupMbid ? "release_group" : "artist",
        artistMbid: obs.artistMbid || null,
        releaseGroupMbid: obs.releaseGroupMbid ?? null,
        artistName: obs.artistName,
        releaseTitle: obs.releaseTitle ?? null,
        firstReleaseDate: obs.firstReleaseDate ?? null,
        navidromeMatchStatus: "unchecked",
        navidromeMatchConfidence: 0,
        evidence: [obs],
        score: 0,
        scoreBreakdown: {},
        primaryReason: obs.reason,
      });
    }
  }

  return Array.from(byKey.values());
}

// --- Step 4: Navidrome match resolution ---

async function resolveNavidromeMatches(
  candidates: CanonicalCandidate[]
): Promise<CanonicalCandidate[]> {
  let libraryAlbums: navidrome.LibraryAlbum[];
  try {
    libraryAlbums = await navidrome.getAllAlbums();
  } catch {
    log("warn", "rec_navidrome_match_skip", { reason: "navidrome unavailable" });
    return candidates;
  }

  const libraryArtistNames = new Set(
    libraryAlbums.map((a) => normalizeForComparison(a.artist))
  );

  for (const candidate of candidates) {
    if (candidate.type === "artist") {
      const normalizedName = normalizeForComparison(candidate.artistName);
      if (libraryArtistNames.has(normalizedName)) {
        candidate.navidromeMatchStatus = "matched";
        candidate.navidromeMatchConfidence = 0.95;
      } else {
        candidate.navidromeMatchStatus = "not_found";
        candidate.navidromeMatchConfidence = 0.8;
      }
    } else if (candidate.type === "release_group" && candidate.releaseTitle) {
      const artistAlbums = libraryAlbums.filter(
        (a) => normalizeForComparison(a.artist) === normalizeForComparison(candidate.artistName)
      );

      if (artistAlbums.length === 0) {
        candidate.navidromeMatchStatus = "not_found";
        candidate.navidromeMatchConfidence = 0.9;
        continue;
      }

      const { matchCatalogToLibrary } = await import("./catalog");
      const results = matchCatalogToLibrary(
        [{
          id: candidate.releaseGroupMbid ?? "",
          title: candidate.releaseTitle,
          primaryType: "Album",
          secondaryTypes: [],
          firstReleaseDate: candidate.firstReleaseDate ?? undefined,
        }],
        artistAlbums,
        candidate.artistName
      );

      const result = results[0];
      if (result) {
        candidate.navidromeMatchStatus = result.classification;
        candidate.navidromeMatchConfidence = result.confidence;
      }
    }
  }

  return candidates;
}

// --- Step 5: Scoring ---

export function scoreCandidate(candidate: CanonicalCandidate): CanonicalCandidate {
  const config = getConfig();
  const evidence = candidate.evidence;

  const externalSimilarity = computeExternalSimilarity(evidence);
  const seedAffinity = computeSeedAffinity(evidence);
  const sourceConsensus = computeSourceConsensus(evidence);
  const recency = computeRecency(candidate.firstReleaseDate);
  const novelty = computeNovelty(candidate);
  const popularity = 0.5;

  const score =
    config.RECOMMENDATION_WEIGHT_EXTERNAL * externalSimilarity +
    config.RECOMMENDATION_WEIGHT_SEED_AFFINITY * seedAffinity +
    config.RECOMMENDATION_WEIGHT_CONSENSUS * sourceConsensus +
    config.RECOMMENDATION_WEIGHT_RECENCY * recency +
    config.RECOMMENDATION_WEIGHT_NOVELTY * novelty +
    config.RECOMMENDATION_WEIGHT_POPULARITY * popularity;

  candidate.score = Math.min(1.0, Math.max(0, score));
  candidate.scoreBreakdown = {
    external_similarity: round(externalSimilarity),
    seed_affinity: round(seedAffinity),
    source_consensus: round(sourceConsensus),
    recency: round(recency),
    novelty: round(novelty),
    popularity: round(popularity),
  };

  const reasons = new Set(evidence.map((e) => e.reason));
  candidate.primaryReason = selectPrimaryReason(reasons, evidence);

  return candidate;
}

function computeExternalSimilarity(evidence: SourceObservation[]): number {
  const scores = evidence
    .map((e) => e.sourceScore)
    .filter((s) => s > 0)
    .sort((a, b) => b - a);

  if (scores.length === 0) return 0;
  const top3 = scores.slice(0, 3);
  return Math.min(1.0, top3.reduce((sum, s) => sum + s, 0) / top3.length);
}

function computeSeedAffinity(evidence: SourceObservation[]): number {
  const affinities = evidence
    .map((e) => e.seedAffinity)
    .filter((a) => a > 0)
    .sort((a, b) => b - a);

  if (affinities.length === 0) return 0;
  return Math.min(1.0, affinities[0] ?? 0);
}

function computeSourceConsensus(evidence: SourceObservation[]): number {
  const uniqueSources = new Set(evidence.map((e) => e.source));
  const uniqueSeeds = new Set(
    evidence.filter((e) => e.seedArtistMbid).map((e) => e.seedArtistMbid)
  );

  const sourceBonus = Math.min(1.0, (uniqueSources.size - 1) * 0.5);
  const seedBonus = Math.min(1.0, (uniqueSeeds.size - 1) * 0.25);

  return Math.min(1.0, sourceBonus + seedBonus);
}

function computeRecency(firstReleaseDate: string | null): number {
  if (!firstReleaseDate) return 0.5;

  const releaseTime = new Date(firstReleaseDate).getTime();
  if (isNaN(releaseTime)) return 0.5;

  const ageMs = Date.now() - releaseTime;
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);

  if (ageYears < 0.5) return 1.0;
  if (ageYears < 1) return 0.9;
  if (ageYears < 2) return 0.7;
  if (ageYears < 5) return 0.5;
  if (ageYears < 10) return 0.3;
  return 0.1;
}

function computeNovelty(candidate: CanonicalCandidate): number {
  if (candidate.navidromeMatchStatus === "not_found" && candidate.type === "artist") {
    return 1.0;
  }
  if (candidate.navidromeMatchStatus === "not_found") {
    return 0.9;
  }
  return 0.5;
}

function selectPrimaryReason(
  reasons: Set<RecommendationReason>,
  _evidence: SourceObservation[]
): RecommendationReason {
  if (reasons.has("collaborative")) return "collaborative";
  if (reasons.has("new_release")) return "new_release";
  if (reasons.has("similar_to_recent")) return "similar_to_recent";
  if (reasons.has("similar_to_favorite")) return "similar_to_favorite";
  return "wildcard";
}

// --- Step 6: Diversity ---

function applyDiversity(
  scored: CanonicalCandidate[],
  limit: number
): CanonicalCandidate[] {
  const config = getConfig();
  const maxPerSeed = config.RECOMMENDATION_MAX_PER_SEED;
  const maxPerArtist = config.RECOMMENDATION_MAX_RELEASES_PER_ARTIST;
  const wildcardRatio = config.RECOMMENDATION_WILDCARD_RATIO;
  const cooldownDays = config.RECOMMENDATION_REPEAT_COOLDOWN_DAYS;

  const recentMbids = getRecentlyRecommendedMbids(cooldownDays);

  const seedCounts = new Map<string, number>();
  const artistCounts = new Map<string, number>();
  const selected: CanonicalCandidate[] = [];
  const wildcardPool: CanonicalCandidate[] = [];

  const mainLimit = Math.ceil(limit * (1 - wildcardRatio));
  const wildcardLimit = limit - mainLimit;

  for (const candidate of scored) {
    if (selected.length >= mainLimit) {
      wildcardPool.push(candidate);
      continue;
    }

    const mbidKey = candidate.releaseGroupMbid ?? candidate.artistMbid ?? "";
    if (mbidKey && recentMbids.has(mbidKey)) continue;

    const primarySeed = candidate.evidence[0]?.seedArtistMbid ?? candidate.evidence[0]?.seedArtistName ?? "";
    if (primarySeed) {
      const count = seedCounts.get(primarySeed) ?? 0;
      if (count >= maxPerSeed) {
        wildcardPool.push(candidate);
        continue;
      }
      seedCounts.set(primarySeed, count + 1);
    }

    const artistKey = candidate.artistMbid ?? normalizeForComparison(candidate.artistName);
    if (candidate.type === "release_group") {
      const count = artistCounts.get(artistKey) ?? 0;
      if (count >= maxPerArtist) {
        wildcardPool.push(candidate);
        continue;
      }
      artistCounts.set(artistKey, count + 1);
    }

    selected.push(candidate);
  }

  const wildcards = wildcardPool
    .filter((c) => {
      const mbidKey = c.releaseGroupMbid ?? c.artistMbid ?? "";
      return !mbidKey || !recentMbids.has(mbidKey);
    })
    .slice(0, wildcardLimit);

  for (const w of wildcards) {
    w.primaryReason = "wildcard";
  }

  return [...selected, ...wildcards];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
