import { Hono } from "hono";
import { z } from "zod";
import { getConfig } from "../config";
import { getCache, setCache } from "../db/repositories/cache";
import { normalizeForComparison } from "../domain/normalization";
import { matchLibraryTrack } from "../domain/track-ownership";
import * as navidrome from "../services/navidrome";

export const libraryOwnershipRoutes = new Hono();

const trackSchema = z.object({
  id: z.string().min(1).max(128),
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  duration_ms: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).optional(),
});

const bodySchema = z.object({
  tracks: z.array(trackSchema).min(1).max(100),
});

type InputTrack = z.infer<typeof trackSchema>;

type OwnershipResponse = {
  id: string;
  status: "owned" | "uncertain" | "missing" | "unknown";
  confidence: number;
  match: {
    navidrome_id: string;
    artist: string;
    title: string;
    album: string;
    duration_ms: number;
    reasons: string[];
  } | null;
};

function cacheKey(track: InputTrack) {
  const durationBucket = track.duration_ms ? Math.round(track.duration_ms / 5000) : 0;
  return [
    "lib:track-ownership:v1",
    normalizeForComparison(track.artist),
    normalizeForComparison(track.title),
    normalizeForComparison(track.album ?? ""),
    durationBucket,
  ].join(":");
}

function mergeSongs<T extends { id: string }>(...groups: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const group of groups) for (const item of group) byId.set(item.id, item);
  return [...byId.values()];
}

async function lookupTrack(track: InputTrack): Promise<OwnershipResponse> {
  const key = cacheKey(track);
  const cached = getCache<OwnershipResponse>(key);
  if (cached) return { ...cached, id: track.id };

  try {
    const first = await navidrome.search3(`${track.artist} ${track.title}`, {
      artistCount: 0,
      albumCount: 0,
      songCount: 25,
    });

    let songs = first.songs;
    let result = matchLibraryTrack(
      {
        artist: track.artist,
        title: track.title,
        album: track.album,
        durationMs: track.duration_ms,
      },
      songs
    );

    // Navidrome search can occasionally rank a title-only query better than
    // artist+title. Only pay for the fallback when the first pass is not owned.
    if (result.status !== "owned") {
      const fallback = await navidrome.search3(track.title, {
        artistCount: 0,
        albumCount: 0,
        songCount: 50,
      });
      songs = mergeSongs(songs, fallback.songs);
      result = matchLibraryTrack(
        {
          artist: track.artist,
          title: track.title,
          album: track.album,
          durationMs: track.duration_ms,
        },
        songs
      );
    }

    const response: OwnershipResponse = {
      id: track.id,
      status: result.status,
      confidence: Math.round(result.confidence * 1000) / 1000,
      match: result.match
        ? {
            navidrome_id: result.match.navidromeId,
            artist: result.match.artist,
            title: result.match.title,
            album: result.match.album,
            duration_ms: result.match.durationMs,
            reasons: result.match.reasons,
          }
        : null,
    };

    setCache(
      key,
      response,
      getConfig().LIBRARY_CACHE_MINUTES * 60 * 1000
    );
    return response;
  } catch {
    return { id: track.id, status: "unknown", confidence: 0, match: null };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

libraryOwnershipRoutes.post("/library/ownership/tracks", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
          retryable: false,
        },
      },
      400
    );
  }

  const results = await mapWithConcurrency(parsed.data.tracks, 8, lookupTrack);
  const summary = {
    owned: results.filter((r) => r.status === "owned").length,
    uncertain: results.filter((r) => r.status === "uncertain").length,
    missing: results.filter((r) => r.status === "missing").length,
    unknown: results.filter((r) => r.status === "unknown").length,
  };

  return c.json({ results, summary });
});
