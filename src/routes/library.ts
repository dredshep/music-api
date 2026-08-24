import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import * as navidrome from "../services/navidrome";
import {
  getCachedLibraryDiskUsage,
  isLibraryDiskUsageRefreshPending,
  scheduleLibraryDiskUsageRefresh,
} from "../services/library-storage";
import { matchLibraryAlbums } from "../domain/matching";
import { getCache, setCache } from "../db/repositories/cache";
import { getConfig } from "../config";
import { listJobs } from "../db/repositories/jobs";
import { getJobFiles } from "../db/repositories/job-files";
import { getLibraryScanStatus } from "../services/scan-status";

export const libraryRoutes = new Hono();

const librarySearchSchema = z.object({
  artist: z.string().min(1).max(500),
  title: z.string().max(500).optional().default(""),
  release_type: z
    .enum(["album", "ep", "single", "track", "any"])
    .optional()
    .default("any"),
  include_songs: z.boolean().optional().default(false),
  include_downloads: z.boolean().optional().default(true),
});

libraryRoutes.post("/library/search", async (c) => {
  const body = await c.req.json();
  const parsed = librarySearchSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { artist, title, release_type, include_songs, include_downloads } = parsed.data;
  const config = getConfig();

  // Check cache (exclude volatile download/scan fields from cache key)
  const cacheKey = `lib:search:${artist.toLowerCase()}:${title.toLowerCase()}:${release_type}:${include_songs}`;
  const cached = getCache<unknown>(cacheKey);
  if (cached && !include_downloads) return c.json(cached);

  // Search Navidrome
  const query = title ? `${artist} ${title}` : artist;
  const results = await navidrome.search3(query, {
    albumCount: 30,
    artistCount: 10,
    songCount: 0,
  });

  // Match
  const ownershipResult = matchLibraryAlbums(artist, title || artist, results.albums);

  const matches = await Promise.all(
    ownershipResult.matches.map(async (m) => {
      const entry: Record<string, unknown> = {
        artist: m.artist,
        title: m.title,
        year: m.year,
        track_count: m.trackCount,
        navidrome_id: m.navidromeId,
        confidence: Math.round(m.confidence * 100) / 100,
        match_reasons: m.matchReasons,
      };

      if (
        include_songs &&
        m.confidence >= 0.85 &&
        ownershipResult.matches[0]?.navidromeId === m.navidromeId
      ) {
        try {
          const albumData = await navidrome.getAlbum(m.navidromeId);
          entry.songs = albumData.songs.map((s) => ({
            navidrome_id: s.id,
            track: s.track,
            title: s.title,
            duration_s: s.duration,
          }));
        } catch {
          entry.songs = [];
        }
      }

      return entry;
    })
  );

  let recentDownloads: Array<Record<string, unknown>> | undefined;
  if (include_downloads) {
    const jobs = listJobs({
      status: "all",
      artist,
      release: title || undefined,
      limit: 20,
      sinceDays: 180,
    });

    recentDownloads = jobs.map((job) => {
      const files = getJobFiles(job.id);
      return {
        job_id: job.id,
        artist: job.artist,
        release: job.release_title,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        audio_files: files
          .filter((f) => f.kind === "audio")
          .map((f) => ({ filename: f.logical_filename, status: f.status })),
        lyrics_files: files
          .filter((f) => f.kind === "lyrics")
          .map((f) => ({ filename: f.logical_filename, status: f.status })),
      };
    });
  }

  let scanStatus: Awaited<ReturnType<typeof getLibraryScanStatus>> | undefined;
  try {
    scanStatus = await getLibraryScanStatus();
  } catch {
    scanStatus = undefined;
  }

  const response = {
    query: { artist, title: title || undefined, release_type },
    owned: ownershipResult.owned,
    confidence: Math.round(ownershipResult.confidence * 100) / 100,
    indexed: ownershipResult.owned,
    scan: scanStatus,
    matches,
    recent_downloads: recentDownloads,
    handoff_hint: buildHandoffHint({
      owned: ownershipResult.owned,
      scanning: scanStatus?.scanning,
      recentDownloads,
      topMatch: matches[0],
    }),
  };

  // Cache ownership match only (downloads/scan stay fresh on each request when include_downloads)
  if (!include_downloads) {
    setCache(cacheKey, response, config.LIBRARY_CACHE_MINUTES * 60 * 1000);
  }

  return c.json(response);
});

function buildHandoffHint(params: {
  owned: boolean;
  scanning?: boolean;
  recentDownloads?: Array<Record<string, unknown>>;
  topMatch?: Record<string, unknown>;
}): string {
  const { owned, scanning, recentDownloads, topMatch } = params;
  const hasCompletedJob = recentDownloads?.some((j) => j.status === "completed");

  if (owned && topMatch?.navidrome_id) {
    if (topMatch.songs) {
      return "Release indexed. Use navidrome_id from matches[0] with auditReleaseLyrics or fillMissingLyrics.";
    }
    return "Release indexed. Use matches[0].navidrome_id with auditReleaseLyrics or fillMissingLyrics.";
  }

  if (hasCompletedJob && !owned) {
    if (scanning) {
      return "Download completed but not indexed yet. Navidrome scan in progress — retry searchLibrary, then run lyrics audit/fill.";
    }
    return "Download completed but not indexed in Navidrome. Run startLibraryScan, wait, then retry searchLibrary before lyrics audit/fill.";
  }

  if (recentDownloads?.some((j) => j.status === "downloading" || j.status === "queued")) {
    return "Download in progress. Poll getTransfers or retry after completion.";
  }

  return "No indexed match and no recent completed download found for this query.";
}

libraryRoutes.get("/library/overview", async (c) => {
  const config = getConfig();
  const topLimit = Math.min(
    Math.max(parseInt(c.req.query("top") ?? "50", 10) || 50, 1),
    200
  );
  const by =
    c.req.query("by") === "play_count" ? "play_count" : "album_count";

  const cacheKey = `lib:overview:v3:${by}:${topLimit}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return c.json(attachDiskUsageToOverview(cached));
  }

  const artists = await navidrome.getArtists();
  const totalAlbums = artists.reduce((sum, a) => sum + (a.albumCount ?? 0), 0);

  if (!getCachedLibraryDiskUsage() && getConfig().LIBRARY_MUSIC_PATH?.trim()) {
    scheduleLibraryDiskUsageRefresh();
  }

  let topArtists: Array<{
    name: string;
    album_count?: number;
    play_count?: number;
    albums_with_plays?: number;
    navidrome_id: string;
  }>;
  let playStats:
    | { albums_with_plays: number; method: string }
    | undefined;

  if (by === "play_count") {
    const ranked = await navidrome.getTopArtistsByPlayCount(topLimit);
    playStats = {
      albums_with_plays: ranked.albums_with_plays,
      method: ranked.method,
    };
    const albumCountById = new Map(artists.map((a) => [a.id, a.albumCount]));
    topArtists = ranked.artists.map((a) => ({
      name: a.name,
      play_count: a.playCount,
      albums_with_plays: a.albumCountWithPlays,
      album_count: albumCountById.get(a.id),
      navidrome_id: a.id,
    }));
  } else {
    topArtists = [...artists]
      .sort((a, b) => (b.albumCount ?? 0) - (a.albumCount ?? 0))
      .slice(0, topLimit)
      .map((a) => ({
        name: a.name,
        album_count: a.albumCount,
        navidrome_id: a.id,
      }));
  }

  const base = {
    summary: {
      artist_count: artists.length,
      album_count: totalAlbums,
      ...(playStats
        ? { albums_with_plays: playStats.albums_with_plays }
        : {}),
    },
    ranked_by: by,
    ...(playStats ? { play_count_method: playStats.method } : {}),
    top_artists: topArtists,
  };

  setCache(cacheKey, base, config.LIBRARY_CACHE_MINUTES * 60 * 1000);
  return c.json(attachDiskUsageToOverview(base));
});

function attachDiskUsageToOverview(
  overview: Record<string, unknown>
): Record<string, unknown> {
  const summary = { ...(overview.summary as Record<string, unknown>) };
  delete summary.disk_bytes;
  delete summary.disk_gb;
  delete summary.disk_tb;
  delete summary.disk_display;
  delete summary.disk_status;

  const diskUsage = getCachedLibraryDiskUsage();
  if (!diskUsage && getConfig().LIBRARY_MUSIC_PATH?.trim()) {
    scheduleLibraryDiskUsageRefresh();
  }

  return {
    ...overview,
    summary: {
      ...summary,
      ...(diskUsage
        ? {
            disk_bytes: diskUsage.bytes,
            disk_gb: diskUsage.gb,
            disk_tb: diskUsage.tb,
            disk_display: diskUsage.display,
          }
        : getConfig().LIBRARY_MUSIC_PATH?.trim()
          ? {
              disk_status: isLibraryDiskUsageRefreshPending()
                ? "computing"
                : "unavailable",
            }
          : {}),
    },
  };
}

libraryRoutes.get("/library/artists", async (c) => {
  const config = getConfig();
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1),
    500
  );
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const sortParam = c.req.query("sort") ?? "album_count";
  const sort =
    sortParam === "name" || sortParam === "play_count"
      ? sortParam
      : "album_count";
  const q = (c.req.query("q") ?? "").trim().toLowerCase();

  const cacheKey = `lib:artists:${sort}:${q}:${offset}:${limit}`;
  const cached = getCache<unknown>(cacheKey);
  if (cached) return c.json(cached);

  if (sort === "play_count") {
    const ranked = await navidrome.getTopArtistsByPlayCount(500);
    let list = ranked.artists;
    if (q) {
      list = list.filter((a) => a.name.toLowerCase().includes(q));
    }
    const total = list.length;
    const page = list.slice(offset, offset + limit).map((a) => ({
      name: a.name,
      play_count: a.playCount,
      albums_with_plays: a.albumCountWithPlays,
      navidrome_id: a.id,
    }));

    const response = {
      total,
      offset,
      limit,
      sort,
      play_count_method: ranked.method,
      albums_with_plays: ranked.albums_with_plays,
      artists: page,
    };
    setCache(cacheKey, response, config.LIBRARY_CACHE_MINUTES * 60 * 1000);
    return c.json(response);
  }

  let artists = await navidrome.getArtists();

  if (q) {
    artists = artists.filter((a) => a.name.toLowerCase().includes(q));
  }

  if (sort === "name") {
    artists = [...artists].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  } else {
    artists = [...artists].sort(
      (a, b) =>
        (b.albumCount ?? 0) - (a.albumCount ?? 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  const total = artists.length;
  const page = artists.slice(offset, offset + limit).map((a) => ({
    name: a.name,
    album_count: a.albumCount,
    navidrome_id: a.id,
  }));

  const response = {
    total,
    offset,
    limit,
    sort,
    artists: page,
  };

  setCache(cacheKey, response, config.LIBRARY_CACHE_MINUTES * 60 * 1000);
  return c.json(response);
});

libraryRoutes.get("/library/scan", async (c) => {
  const status = await getLibraryScanStatus();
  return c.json(status);
});

libraryRoutes.post("/library/scan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const full = (body as Record<string, unknown>).full === true;

  await navidrome.startScan(full);

  return c.json({
    status: "started",
    full,
  });
});
