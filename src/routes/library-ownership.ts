import { Hono } from "hono";
import { z } from "zod";
import { getConfig } from "../config";
import { getCache, setCache } from "../db/repositories/cache";
import { normalizeForComparison } from "../domain/normalization";
import {
  getLibraryOwnershipIndex,
  getLibrarySnapshot,
  getOrBuildLibrarySnapshot,
  type LibrarySnapshot,
} from "../services/library-snapshot";

export const libraryOwnershipRoutes = new Hono();

const trackSchema = z.object({
  id: z.string().min(1).max(128),
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  duration_ms: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).optional(),
});

const bodySchema = z.object({
  tracks: z.array(trackSchema).min(1).max(500),
  refresh_library_snapshot: z.boolean().optional().default(false),
});

type InputTrack = z.infer<typeof trackSchema>;

type OwnershipResponse = {
  id: string;
  status: "owned" | "uncertain" | "missing" | "unknown";
  confidence: number;
  match: {
    navidrome_id: string;
    navidrome_artist_id: string;
    navidrome_album_id: string;
    artist: string;
    title: string;
    album: string;
    duration_ms: number;
    reasons: string[];
  } | null;
};

function cacheKey(track: InputTrack, snapshotVersion: string) {
  const durationBucket = track.duration_ms ? Math.round(track.duration_ms / 5000) : 0;
  return [
    "lib:track-ownership:v3",
    snapshotVersion,
    normalizeForComparison(track.artist),
    normalizeForComparison(track.title),
    normalizeForComparison(track.album ?? ""),
    durationBucket,
  ].join(":");
}

function lookupTrack(track: InputTrack, snapshot: LibrarySnapshot): OwnershipResponse {
  const key = cacheKey(track, snapshot.version);
  const cached = getCache<OwnershipResponse>(key);
  if (cached) return { ...cached, id: track.id };

  try {
    const result = getLibraryOwnershipIndex(snapshot).lookup(
      {
        artist: track.artist,
        title: track.title,
        album: track.album,
        durationMs: track.duration_ms,
      }
    );

    const response: OwnershipResponse = {
      id: track.id,
      status: result.status,
      confidence: Math.round(result.confidence * 1000) / 1000,
      match: result.match
        ? {
            navidrome_id: result.match.navidromeId,
            navidrome_artist_id: result.match.artistId,
            navidrome_album_id: result.match.albumId,
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

  const previous = getLibrarySnapshot();
  let snapshot: LibrarySnapshot | null = null;
  let snapshotError: string | null = null;
  try {
    snapshot = await getOrBuildLibrarySnapshot(parsed.data.refresh_library_snapshot);
    snapshotError = snapshot.lastError;
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
    snapshot = previous;
  }

  const results: OwnershipResponse[] = snapshot
    ? parsed.data.tracks.map((track) => lookupTrack(track, snapshot!))
    : parsed.data.tracks.map((track) => ({ id: track.id, status: "unknown" as const, confidence: 0, match: null }));
  const summary = {
    owned: results.filter((r) => r.status === "owned").length,
    uncertain: results.filter((r) => r.status === "uncertain").length,
    missing: results.filter((r) => r.status === "missing").length,
    unknown: results.filter((r) => r.status === "unknown").length,
  };

  return c.json({
    results,
    summary,
    snapshot_version: snapshot?.version ?? null,
    snapshot_built_at: snapshot?.builtAt ?? null,
    snapshot_total: snapshot?.songCount ?? 0,
    snapshot_stale: snapshot ? snapshot.stale : true,
    snapshot_rebuild_error: snapshotError,
    snapshot: snapshot
      ? {
          version: snapshot.version,
          built_at: snapshot.builtAt,
          total: snapshot.songCount,
          stale: snapshot.stale,
          last_error: snapshot.lastError,
        }
      : null,
  });
});
