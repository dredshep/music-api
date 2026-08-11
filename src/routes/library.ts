import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import * as navidrome from "../services/navidrome";
import { matchLibraryAlbums } from "../domain/matching";
import { getCache, setCache } from "../db/repositories/cache";
import { getConfig } from "../config";

export const libraryRoutes = new Hono();

const librarySearchSchema = z.object({
  artist: z.string().min(1),
  title: z.string().optional().default(""),
  release_type: z
    .enum(["album", "ep", "single", "track", "any"])
    .optional()
    .default("any"),
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

  const { artist, title, release_type } = parsed.data;
  const config = getConfig();

  // Check cache
  const cacheKey = `lib:search:${artist.toLowerCase()}:${title.toLowerCase()}:${release_type}`;
  const cached = getCache<unknown>(cacheKey);
  if (cached) return c.json(cached);

  // Search Navidrome
  const query = title ? `${artist} ${title}` : artist;
  const results = await navidrome.search3(query, {
    albumCount: 30,
    artistCount: 10,
    songCount: 0,
  });

  // Match
  const ownershipResult = matchLibraryAlbums(artist, title || artist, results.albums);

  const response = {
    query: { artist, title: title || undefined, release_type },
    owned: ownershipResult.owned,
    confidence: Math.round(ownershipResult.confidence * 100) / 100,
    matches: ownershipResult.matches.map((m) => ({
      artist: m.artist,
      title: m.title,
      year: m.year,
      track_count: m.trackCount,
      navidrome_id: m.navidromeId,
      confidence: Math.round(m.confidence * 100) / 100,
      match_reasons: m.matchReasons,
    })),
  };

  // Cache for configured duration
  setCache(cacheKey, response, config.LIBRARY_CACHE_MINUTES * 60 * 1000);

  return c.json(response);
});

libraryRoutes.get("/library/overview", async (c) => {
  const config = getConfig();
  const topLimit = Math.min(
    Math.max(parseInt(c.req.query("top") ?? "50", 10) || 50, 1),
    200
  );
  const by =
    c.req.query("by") === "play_count" ? "play_count" : "album_count";

  const cacheKey = `lib:overview:${by}:${topLimit}`;
  const cached = getCache<unknown>(cacheKey);
  if (cached) return c.json(cached);

  const artists = await navidrome.getArtists();
  const totalAlbums = artists.reduce((sum, a) => sum + (a.albumCount ?? 0), 0);

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

  const response = {
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

  setCache(cacheKey, response, config.LIBRARY_CACHE_MINUTES * 60 * 1000);
  return c.json(response);
});

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
  const status = await navidrome.getScanStatus();

  return c.json({
    scanning: status.scanning,
    last_scan: status.count ? undefined : undefined,
  });
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
