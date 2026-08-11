import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { getConfig } from "../config";
import { log } from "../middleware/logging";
import * as slskd from "../services/slskd";
import { createSearch, getSearch, isSearchExpired } from "../db/repositories/searches";
import {
  createCandidate,
  getCandidatesBySearch,
} from "../db/repositories/candidates";
import {
  groupByDirectory,
  computeStats,
  buildDisplayRelease,
  type RawCandidate,
} from "../domain/candidates";
import { detectFlags } from "../domain/flags";
import { scoreCandidate } from "../domain/scoring";
import { matchLibraryAlbums } from "../domain/matching";
import * as navidrome from "../services/navidrome";
import { getCache, setCache } from "../db/repositories/cache";

export const searchRoutes = new Hono();

const searchSchema = z.object({
  artist: z.string().min(1),
  title: z.string().min(1),
  release_type: z
    .enum(["album", "ep", "single", "track", "any"])
    .optional()
    .default("album"),
  preferred_formats: z.array(z.string()).optional().default(["FLAC", "MP3"]),
  prefer_lrc: z.boolean().optional().default(true),
  max_candidates: z.coerce.number().min(1).max(20).optional().default(10),
});

searchRoutes.post("/search", async (c) => {
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

  // Generate search queries (2-4 variants)
  const queries = generateSearchQueries(artist, title, preferred_formats);

  log("info", "soulseek_search_initiated", {
    artist,
    title,
    queries: queries.length,
  });

  // Start slskd searches serially (slskd allows only one concurrent start)
  const searches = await slskd.startSearches(queries);
  const slskdSearchIds = searches.map((s) => s.id);

  // Wait for responses
  const allResponses = await Promise.all(
    slskdSearchIds.map((id) =>
      slskd.waitForSearchCompletion(id, config.SEARCH_COLLECTION_MS)
    )
  );

  const flatResponses = allResponses.flat();

  // Group by peer + directory
  const rawCandidates = groupByDirectory(flatResponses);

  // Pre-rank and take top N for enrichment
  const preRanked = preRankCandidates(rawCandidates, artist, title);
  const topCandidates = preRanked.slice(0, 30);

  // Directory enrichment: fetch full directory contents for top candidates
  const enriched = await enrichCandidates(topCandidates);

  // Build, score, and persist candidates
  const searchRecord = createSearch({
    artist,
    title,
    releaseType: release_type,
    rawQuery: queries.join(" | "),
    slskdSearchIds,
    ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
  });

  const candidateRecords = [];
  for (const raw of enriched.slice(0, max_candidates * 2)) {
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
      preferredFormats: preferred_formats,
      preferLrc: prefer_lrc,
    });

    const displayRelease = buildDisplayRelease(raw.directory, artist, title);

    const record = createCandidate({
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

  // Sort by score and limit
  candidateRecords.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const finalCandidates = candidateRecords.slice(0, max_candidates);

  log("info", "soulseek_search_completed", {
    search_id: searchRecord.id,
    raw_results: flatResponses.reduce((sum, r) => sum + r.files.length, 0),
    candidate_directories: rawCandidates.length,
    directories_enriched: enriched.length,
    returned_candidates: finalCandidates.length,
  });

  return c.json({
    search_id: searchRecord.id,
    query: { artist, title, release_type },
    candidates: finalCandidates.map((r) => ({
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
    })),
  });
});

searchRoutes.get("/searches/:search_id", async (c) => {
  const searchId = c.req.param("search_id");
  const config = getConfig();

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

  // Re-poll slskd searches for updated results
  const slskdIds: string[] = search.slskd_search_ids_json
    ? JSON.parse(search.slskd_search_ids_json)
    : [];

  if (slskdIds.length > 0) {
    const freshResponses = await Promise.all(
      slskdIds.map((id) => slskd.getSearchResponses(id))
    );
    const flatResponses = freshResponses.flat();
    const rawCandidates = groupByDirectory(flatResponses);
    const preRanked = preRankCandidates(rawCandidates, search.artist, search.title);
    const enriched = await enrichCandidates(preRanked.slice(0, 30));

    // Re-score and update candidates
    for (const raw of enriched) {
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
        preferLrc: true,
      });

      const displayRelease = buildDisplayRelease(
        raw.directory,
        search.artist,
        search.title
      );

      createCandidate({
        searchId: search.id,
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
    }
  }

  // Return current candidates
  const candidates = getCandidatesBySearch(searchId);
  const maxCandidates = config.DEFAULT_MAX_CANDIDATES;

  // Deduplicate by peer+directory, keep highest-scored
  const seen = new Map<string, typeof candidates[0]>();
  for (const cand of candidates) {
    const key = `${cand.peer}::${cand.remote_directory}`;
    const existing = seen.get(key);
    if (!existing || (cand.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, cand);
    }
  }

  const deduped = Array.from(seen.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxCandidates);

  return c.json({
    search_id: search.id,
    query: {
      artist: search.artist,
      title: search.title,
      release_type: search.release_type,
    },
    candidates: deduped.map((r) => ({
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
    })),
  });
});

// Convenience endpoint: check library first, then search if not owned
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

  // Not owned — trigger Soulseek search via internal logic
  const config = getConfig();
  const queries = generateSearchQueries(artist, title, ["FLAC", "MP3"]);
  const searches = await slskd.startSearches(queries);
  const slskdSearchIds = searches.map((s) => s.id);

  const allResponses = await Promise.all(
    slskdSearchIds.map((id) =>
      slskd.waitForSearchCompletion(id, config.SEARCH_COLLECTION_MS)
    )
  );

  const flatResponses = allResponses.flat();
  const rawCandidates = groupByDirectory(flatResponses);
  const preRanked = preRankCandidates(rawCandidates, artist, title);
  const enriched = await enrichCandidates(preRanked.slice(0, 30));

  const searchRecord = createSearch({
    artist,
    title,
    releaseType: release_type,
    rawQuery: queries.join(" | "),
    slskdSearchIds,
    ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
  });

  const candidateRecords = [];
  for (const raw of enriched.slice(0, 20)) {
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
      preferLrc: true,
    });

    const displayRelease = buildDisplayRelease(raw.directory, artist, title);

    const record = createCandidate({
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
  const finalCandidates = candidateRecords.slice(0, config.DEFAULT_MAX_CANDIDATES);

  return c.json({
    status: "not_owned",
    library_match: null,
    search_id: searchRecord.id,
    candidates: finalCandidates.map((r) => ({
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
    })),
  });
});

// --- Helpers ---

function generateSearchQueries(
  artist: string,
  title: string,
  preferredFormats: string[]
): string[] {
  const queries: string[] = [];

  queries.push(`${artist} ${title}`);
  queries.push(`${artist} - ${title}`);

  // Add format-specific query for top preferred format
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
  // Quick pre-rank: prefer directories with more audio files and free slots
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

async function enrichCandidates(
  candidates: RawCandidate[]
): Promise<RawCandidate[]> {
  const enriched: RawCandidate[] = [];

  for (const raw of candidates) {
    try {
      const dirInfo = await slskd.getUserDirectory(raw.peer, raw.directory);

      if (dirInfo && dirInfo.files && dirInfo.files.length > 0) {
        // Replace with enriched file list
        const { classifyFile, getFilename } = await import("../domain/candidates");
        const enrichedFiles = dirInfo.files.map((f) => {
          const fname = getFilename(f.filename);
          const { kind, extension } = classifyFile(fname);
          return { filename: f.filename, size: f.size, kind, extension };
        });

        enriched.push({
          ...raw,
          files: enrichedFiles,
        });
      } else {
        // Use original search-hit files
        enriched.push(raw);
      }
    } catch {
      // Enrichment failed; use original files
      enriched.push(raw);
    }
  }

  return enriched;
}
