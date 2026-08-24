import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { getConfig } from "../config";
import { log } from "../middleware/logging";
import * as slskd from "../services/slskd";
import type { SearchCollectionDiagnostics } from "../services/slskd";
import {
  createSearch,
  getSearch,
  isSearchExpired,
  updateSearchLifecycle,
  buildSearchLifecycle,
  type SearchRecord,
} from "../db/repositories/searches";
import {
  upsertCandidate,
  getCandidatesBySearch,
  type CandidateRecord,
} from "../db/repositories/candidates";
import {
  groupByDirectory,
  computeStats,
  buildDisplayRelease,
  classifyFile,
  getFilename,
  type RawCandidate,
  type CandidateFile,
} from "../domain/candidates";
import { detectFlags } from "../domain/flags";
import { scoreCandidate } from "../domain/scoring";
import { matchLibraryAlbums } from "../domain/matching";
import * as navidrome from "../services/navidrome";
import { searchSemaphore } from "../middleware/semaphore";

export const searchRoutes = new Hono();

const formatEnum = z.enum(["FLAC", "MP3", "AAC", "OGG", "OPUS", "WAV", "ALAC", "WMA", "APE"]);

const searchSchema = z.object({
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  release_type: z
    .enum(["album", "ep", "single", "track", "any"])
    .optional()
    .default("album"),
  preferred_formats: z.array(formatEnum).max(10).optional().default(["FLAC", "MP3"]),
  prefer_lrc: z.boolean().optional().default(true),
  max_candidates: z.coerce.number().min(1).max(20).optional().default(10),
});

// --- POST /search: start a new search ---

searchRoutes.post("/search", async (c) => {
  return searchSemaphore.run(async () => {
    const body = await c.req.json();
    const parsed = searchSchema.safeParse(body);

    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        parsed.error.issues.map((i) => i.message).join("; "),
        400
      );
    }

    const { artist, title, release_type, preferred_formats, prefer_lrc, max_candidates } =
      parsed.data;
    const config = getConfig();

    const queries = generateSearchQueries(artist, title, preferred_formats);

    log("info", "soulseek_search_initiated", {
      artist,
      title,
      queries: queries.length,
    });

    // Start slskd searches serially
    const searches = await slskd.startSearches(queries);
    const slskdSearchIds = searches.map((s) => s.id);

    // Create the search record immediately with original options
    const searchRecord = createSearch({
      artist,
      title,
      releaseType: release_type,
      rawQuery: queries.join(" | "),
      slskdSearchIds,
      ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
      preferredFormats: preferred_formats,
      preferLrc: prefer_lrc,
      maxCandidates: max_candidates,
    });

    // Adaptive collection. When prefer_lrc, poll longer for LRC-bearing peers.
    const { responses, diagnostics } = await slskd.collectSearchResults(slskdSearchIds, {
      minMs: config.SEARCH_COLLECTION_MS,
      maxMs: prefer_lrc ? 45000 : 30000,
      preferLrc: prefer_lrc,
    });

    // Build, enrich, score, and persist candidates
    const result = await processResponses({
      responses,
      searchRecord,
      artist,
      title,
      releaseType: release_type,
      preferredFormats: preferred_formats,
      preferLrc: prefer_lrc,
      maxCandidates: max_candidates,
    });

    // Update lifecycle
    const lifecycle = buildSearchLifecycle(searchRecord, diagnostics);
    updateSearchLifecycle(searchRecord.id, {
      state: diagnostics.settled ? "settled" : "collecting",
      diagnostics,
      candidateCount: result.candidates.length,
      lifecycle,
    });

    const warnings = buildWarnings(diagnostics, result.candidates.length);

    log("info", "soulseek_search_completed", {
      search_id: searchRecord.id,
      raw_results: diagnostics.rawFileCount,
      candidate_directories: diagnostics.uniqueDirectories,
      directories_enriched: result.enrichedCount,
      returned_candidates: result.candidates.length,
      settled: diagnostics.settled,
    });

    return c.json({
      search_id: searchRecord.id,
      query: { artist, title, release_type },
      lifecycle,
      diagnostics: {
        raw_file_count: diagnostics.rawFileCount,
        locked_file_count: diagnostics.lockedFileCount,
        peer_response_count: diagnostics.peerResponseCount,
        unique_peers: diagnostics.uniquePeers,
        unique_directories: diagnostics.uniqueDirectories,
        audio_directories: diagnostics.audioDirectories,
        lrc_directories: diagnostics.lrcDirectories,
        collection_ms: diagnostics.collectionMs,
        enrichment_successes: result.enrichedCount,
        enrichment_failures: result.enrichmentFailures,
      },
      warnings,
      candidates: result.candidates.map(serializeCandidate),
    });
  });
});

// --- GET /searches/:search_id: refresh an existing search ---

searchRoutes.get("/searches/:search_id", async (c) => {
  const searchId = c.req.param("search_id");

  const search = getSearch(searchId);
  if (!search) {
    throw new AppError("SEARCH_NOT_FOUND", "Search not found", 404);
  }

  if (isSearchExpired(search)) {
    throw new AppError(
      "SEARCH_EXPIRED",
      "The search has expired. Run the search again.",
      410
    );
  }

  const config = getConfig();

  // Recover original search options
  const opts = parseSearchOptions(search);

  const slskdIds: string[] = search.slskd_search_ids_json
    ? JSON.parse(search.slskd_search_ids_json)
    : [];

  let diagnostics: SearchCollectionDiagnostics | null = null;

  if (slskdIds.length > 0) {
    const collection = await slskd.refreshSearchResults(slskdIds, {
      waitMs: 15000,
    });
    diagnostics = collection.diagnostics;

    // Re-process and upsert candidates
    await processResponses({
      responses: collection.responses,
      searchRecord: search,
      artist: search.artist,
      title: search.title,
      releaseType: search.release_type ?? opts.releaseType,
      preferredFormats: opts.preferredFormats,
      preferLrc: opts.preferLrc,
      maxCandidates: opts.maxCandidates,
    });

    const lifecycle = buildSearchLifecycle(search, diagnostics);
    updateSearchLifecycle(search.id, {
      state: diagnostics.settled ? "settled" : "collecting",
      diagnostics,
      candidateCount: getCandidatesBySearch(search.id).length,
      lifecycle,
    });
  }

  // Return current candidates (deduped by upsert, sorted by score)
  const candidates = getCandidatesBySearch(searchId);
  const maxCandidates = opts.maxCandidates;
  const finalCandidates = candidates.slice(0, maxCandidates);

  const lifecycle = diagnostics
    ? buildSearchLifecycle(search, diagnostics)
    : buildFallbackLifecycle(search);

  const warnings = diagnostics
    ? buildWarnings(diagnostics, finalCandidates.length)
    : [];

  return c.json({
    search_id: search.id,
    query: {
      artist: search.artist,
      title: search.title,
      release_type: search.release_type,
    },
    lifecycle,
    diagnostics: diagnostics
      ? {
          raw_file_count: diagnostics.rawFileCount,
          locked_file_count: diagnostics.lockedFileCount,
          peer_response_count: diagnostics.peerResponseCount,
          unique_peers: diagnostics.uniquePeers,
          unique_directories: diagnostics.uniqueDirectories,
          audio_directories: diagnostics.audioDirectories,
          lrc_directories: diagnostics.lrcDirectories,
          collection_ms: diagnostics.collectionMs,
        }
      : undefined,
    warnings,
    candidates: finalCandidates.map(serializeCandidate),
  });
});

// --- POST /acquire/preview: check library, then search ---

const acquirePreviewSchema = z.object({
  artist: z.string().min(1),
  title: z.string().min(1),
  release_type: z
    .enum(["album", "ep", "single", "track", "any"])
    .optional()
    .default("album"),
});

searchRoutes.post("/acquire/preview", async (c) => {
  const body = await c.req.json();
  const parsed = acquirePreviewSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { artist, title, release_type } = parsed.data;
  const config = getConfig();

  // Check library first
  const query = `${artist} ${title}`;
  const results = await navidrome.search3(query, { albumCount: 20, songCount: 0 });
  const ownership = matchLibraryAlbums(artist, title, results.albums);

  if (ownership.owned && ownership.confidence >= 0.9) {
    const topMatch = ownership.matches[0];
    return c.json({
      status: "owned",
      library_match: topMatch
        ? {
            artist: topMatch.artist,
            title: topMatch.title,
            navidrome_id: topMatch.navidromeId,
          }
        : null,
      candidates: [],
    });
  }

  // Not owned — search via unified path
  const preferredFormats: Array<"FLAC" | "MP3"> = ["FLAC", "MP3"];
  const queries = generateSearchQueries(artist, title, preferredFormats);
  const searches = await slskd.startSearches(queries);
  const slskdSearchIds = searches.map((s) => s.id);

  const searchRecord = createSearch({
    artist,
    title,
    releaseType: release_type,
    rawQuery: queries.join(" | "),
    slskdSearchIds,
    ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
    preferredFormats,
    preferLrc: true,
    maxCandidates: config.DEFAULT_MAX_CANDIDATES,
  });

  const { responses, diagnostics } = await slskd.collectSearchResults(slskdSearchIds, {
    minMs: config.SEARCH_COLLECTION_MS,
    maxMs: 45000,
    preferLrc: true,
  });

  const result = await processResponses({
    responses,
    searchRecord,
    artist,
    title,
    releaseType: release_type,
    preferredFormats,
    preferLrc: true,
    maxCandidates: config.DEFAULT_MAX_CANDIDATES,
  });

  const lifecycle = buildSearchLifecycle(searchRecord, diagnostics);
  updateSearchLifecycle(searchRecord.id, {
    state: diagnostics.settled ? "settled" : "collecting",
    diagnostics,
    candidateCount: result.candidates.length,
    lifecycle,
  });

  const finalCandidates = result.candidates.slice(0, config.DEFAULT_MAX_CANDIDATES);

  return c.json({
    status: "not_owned",
    library_match: null,
    search_id: searchRecord.id,
    lifecycle,
    candidates: finalCandidates.map(serializeCandidate),
  });
});

// --- Shared pipeline ---

interface ProcessResult {
  candidates: CandidateRecord[];
  enrichedCount: number;
  enrichmentFailures: number;
}

async function processResponses(params: {
  responses: slskd.SearchCollectionResult["responses"];
  searchRecord: SearchRecord;
  artist: string;
  title: string;
  releaseType: string;
  preferredFormats: string[];
  preferLrc: boolean;
  maxCandidates: number;
}): Promise<ProcessResult> {
  const { responses, searchRecord, artist, title, releaseType, preferredFormats, preferLrc, maxCandidates } = params;
  const config = getConfig();

  const rawCandidates = groupByDirectory(responses);
  const preRanked = preRankCandidates(rawCandidates, artist, title);

  // Enrichment pool: 30 normally, 60 for prefer_lrc
  const enrichmentLimit = preferLrc ? 60 : 30;
  const topCandidates = preRanked.slice(0, enrichmentLimit);

  const { enriched, failures } = await enrichCandidatesWithTimeout(topCandidates, {
    timeoutMs: 10000,
    concurrency: 5,
  });

  const candidateRecords: CandidateRecord[] = [];
  for (const raw of enriched.slice(0, maxCandidates * 2)) {
    const stats = computeStats(raw.files);
    if (stats.audioFileCount === 0) continue;

    const flags = detectFlags({
      directoryName: raw.directory,
      filenames: raw.files.map((f) => f.filename),
      audioFormats: stats.audioFormats,
      audioFileCount: stats.audioFileCount,
      lrcCount: stats.matchingLrcCount,
      freeUploadSlots: raw.freeUploadSlots,
      uploadSpeed: raw.uploadSpeed,
      queueLength: raw.queueLength,
    });

    const scoring = scoreCandidate({
      stats,
      flags,
      freeUploadSlots: raw.freeUploadSlots,
      uploadSpeed: raw.uploadSpeed,
      queueLength: raw.queueLength,
      expectedTrackCount: undefined,
      preferredFormats,
      preferLrc,
      releaseType,
    });

    const displayRelease = buildDisplayRelease(raw.directory, artist, title);

    const record = upsertCandidate({
      searchId: searchRecord.id,
      peer: raw.peer,
      remoteDirectory: raw.directory,
      displayRelease,
      format: stats.dominantFormat,
      trackCount: stats.trackCount,
      audioFileCount: stats.audioFileCount,
      lrcCount: stats.matchingLrcCount,
      imageCount: stats.imageCount,
      sidecarCount: stats.sidecarCount,
      lrcCoverage: stats.lrcCoverage,
      totalBytes: stats.totalBytes,
      uploadSpeed: raw.uploadSpeed,
      freeUploadSlots: raw.freeUploadSlots,
      queueLength: raw.queueLength,
      score: scoring.score,
      reason: scoring.reason,
      flags,
      files: raw.files,
      ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
    });

    candidateRecords.push(record);
  }

  candidateRecords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    candidates: candidateRecords.slice(0, maxCandidates),
    enrichedCount: enriched.length,
    enrichmentFailures: failures,
  };
}

// --- Enrichment with concurrency and timeout ---

async function enrichCandidatesWithTimeout(
  candidates: RawCandidate[],
  opts: { timeoutMs: number; concurrency: number }
): Promise<{ enriched: RawCandidate[]; failures: number }> {
  const { timeoutMs, concurrency } = opts;
  const deadline = Date.now() + timeoutMs;
  const enriched: RawCandidate[] = [];
  let failures = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < candidates.length; i += concurrency) {
    if (Date.now() >= deadline) {
      // Budget exhausted — use original files for remaining
      for (let j = i; j < candidates.length; j++) {
        enriched.push(candidates[j]);
      }
      break;
    }

    const batch = candidates.slice(i, i + concurrency);
    const remaining = deadline - Date.now();

    const results = await Promise.all(
      batch.map((raw) => enrichSingleCandidate(raw, remaining))
    );

    for (const r of results) {
      enriched.push(r.candidate);
      if (!r.success) failures++;
    }
  }

  return { enriched, failures };
}

async function enrichSingleCandidate(
  raw: RawCandidate,
  timeoutMs: number
): Promise<{ candidate: RawCandidate; success: boolean }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const dirInfo = await slskd.getUserDirectory(raw.peer, raw.directory);

      if (dirInfo?.files && dirInfo.files.length > 0) {
        const enrichedFiles: CandidateFile[] = dirInfo.files.map((f) => {
          const fname = getFilename(f.filename);
          const { kind, extension } = classifyFile(fname);
          return { filename: f.filename, size: f.size, kind, extension };
        });

        return {
          candidate: { ...raw, files: enrichedFiles },
          success: true,
        };
      }
    } finally {
      clearTimeout(timeout);
    }

    return { candidate: raw, success: true };
  } catch {
    return { candidate: raw, success: false };
  }
}

// --- Helpers ---

function generateSearchQueries(
  artist: string,
  title: string,
  preferredFormats: string[]
): string[] {
  const queries: string[] = [];

  queries.push(`${artist} ${title}`);
  queries.push(`${artist} - ${title}`);

  const topFormat = preferredFormats[0];
  if (topFormat) {
    queries.push(`${artist} ${title} ${topFormat}`);
  }

  return queries.slice(0, 4);
}

function preRankCandidates(
  candidates: RawCandidate[],
  artist: string,
  title: string
): RawCandidate[] {
  return candidates
    .map((c) => {
      const audioCount = c.files.filter((f) => f.kind === "audio").length;
      const dirLower = c.directory.toLowerCase();
      const hasArtist = dirLower.includes(artist.toLowerCase());
      const hasTitle = dirLower.includes(title.toLowerCase());

      let preScore = audioCount * 10;
      if (hasArtist) preScore += 20;
      if (hasTitle) preScore += 20;
      if (c.freeUploadSlots) preScore += 10;

      return { candidate: c, preScore };
    })
    .sort((a, b) => b.preScore - a.preScore)
    .map((x) => x.candidate);
}

function parseSearchOptions(search: SearchRecord): {
  preferredFormats: string[];
  preferLrc: boolean;
  maxCandidates: number;
  releaseType: string;
} {
  if (search.search_options_json) {
    try {
      const opts = JSON.parse(search.search_options_json);
      return {
        preferredFormats: opts.preferred_formats ?? ["FLAC", "MP3"],
        preferLrc: opts.prefer_lrc ?? true,
        maxCandidates: opts.max_candidates ?? 10,
        releaseType: opts.release_type ?? search.release_type ?? "album",
      };
    } catch {
      // fall through
    }
  }

  return {
    preferredFormats: search.preferred_formats_json
      ? JSON.parse(search.preferred_formats_json)
      : ["FLAC", "MP3"],
    preferLrc: search.prefer_lrc === 1,
    maxCandidates: search.max_candidates ?? 10,
    releaseType: search.release_type ?? "album",
  };
}

function serializeCandidate(r: CandidateRecord) {
  return {
    id: r.id,
    release: r.display_release,
    peer: r.peer,
    format: r.format,
    track_count: r.track_count,
    lrc_count: r.lrc_count,
    lrc_coverage: r.lrc_coverage,
    has_cover: (r.image_count ?? 0) > 0,
    size_mb: r.total_bytes ? Math.round((r.total_bytes / 1024 / 1024) * 10) / 10 : null,
    upload_speed_mbps: r.upload_speed
      ? Math.round((r.upload_speed / 1000000) * 10) / 10
      : null,
    free_upload_slots: Boolean(r.free_upload_slots),
    queue_length: r.queue_length,
    score: r.score,
    flags: r.flags_json ? JSON.parse(r.flags_json) : [],
    reason: r.reason,
  };
}

function buildWarnings(
  diagnostics: SearchCollectionDiagnostics,
  candidateCount: number
): string[] {
  const warnings: string[] = [];

  if (diagnostics.rawFileCount > 0 && candidateCount === 0) {
    warnings.push("raw_results_without_candidates");
  }

  if (!diagnostics.settled && candidateCount === 0) {
    warnings.push("search_still_collecting");
  }

  const failedSearches = diagnostics.searchStates.filter((s) =>
    s.state.toLowerCase().includes("errored") || s.state.toLowerCase().includes("timedout")
  );
  if (failedSearches.length > 0 && failedSearches.length < diagnostics.searchStates.length) {
    warnings.push("partial_upstream_failure");
  }

  return warnings;
}

function buildFallbackLifecycle(search: SearchRecord) {
  const ageMs = Date.now() - new Date(search.created_at).getTime();
  if (search.lifecycle_json) {
    try {
      return JSON.parse(search.lifecycle_json);
    } catch {
      // fall through
    }
  }
  return {
    state: search.state ?? "collecting",
    age_ms: ageMs,
    collection_ms: 0,
    settled: search.state === "settled",
    last_new_result_at: search.last_refreshed_at,
    recommended_refresh_after_ms: null,
  };
}
