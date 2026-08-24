import { Hono } from "hono";
import { z } from "zod";
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../middleware/errors";
import { log } from "../middleware/logging";
import { getConfig } from "../config";
import * as lrclib from "../services/lrclib";
import * as navidrome from "../services/navidrome";
import {
  createLyricAcquisition,
  getLyricAcquisitionBySong,
} from "../db/repositories/lyrics";

export const lyricsRoutes = new Hono();

// --- POST /lyrics/search ---

const searchSchema = z.object({
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  duration_s: z.number().positive().optional(),
  max_results: z.coerce.number().min(1).max(50).optional().default(10),
});

lyricsRoutes.post("/lyrics/search", async (c) => {
  const body = await c.req.json();
  const parsed = searchSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { artist, title, album, duration_s, max_results } = parsed.data;

  const matches = await lrclib.findBestMatches({
    artist,
    title,
    album,
    durationS: duration_s,
    maxResults: max_results,
  });

  return c.json({
    candidates: matches.map(serializeMatch),
    count: matches.length,
  });
});

// --- GET /lyrics/candidates/:lrclib_id ---

lyricsRoutes.get("/lyrics/candidates/:lrclib_id", async (c) => {
  const lrclibId = parseInt(c.req.param("lrclib_id"), 10);
  if (isNaN(lrclibId)) {
    throw new AppError("VALIDATION_ERROR", "Invalid lrclib_id", 400);
  }

  const track = await lrclib.getById(lrclibId);
  if (!track) {
    throw new AppError("NOT_FOUND", "LRCLIB track not found", 404);
  }

  return c.json({
    lrclib_id: track.id,
    artist: track.artistName,
    title: track.trackName,
    album: track.albumName,
    duration_s: track.duration,
    instrumental: track.instrumental,
    has_synced: track.syncedLyrics != null && track.syncedLyrics.length > 0,
    has_plain: track.plainLyrics != null && track.plainLyrics.length > 0,
    synced_lyrics: track.syncedLyrics,
    plain_lyrics: track.plainLyrics,
  });
});

// --- POST /lyrics/acquire ---

const acquireSchema = z.object({
  lrclib_id: z.number().int().positive(),
  navidrome_song_id: z.string().min(1).max(200),
  synced_only: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(false),
});

lyricsRoutes.post("/lyrics/acquire", async (c) => {
  const body = await c.req.json();
  const parsed = acquireSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { lrclib_id, navidrome_song_id, synced_only, dry_run } = parsed.data;

  // Get lyrics from LRCLIB
  const track = await lrclib.getById(lrclib_id);
  if (!track) {
    throw new AppError("NOT_FOUND", "LRCLIB track not found", 404);
  }

  const lyrics = track.syncedLyrics;
  if (synced_only && !lyrics) {
    throw new AppError(
      "NO_SYNCED_LYRICS",
      "This track has no synced lyrics and synced_only is true",
      422
    );
  }

  const lrcContent = lyrics ?? track.plainLyrics;
  if (!lrcContent) {
    throw new AppError("NO_LYRICS", "This track has no lyrics at all", 422);
  }

  // Get song info from Navidrome to determine target path
  const song = await navidrome.getSong(navidrome_song_id);
  if (!song.path) {
    throw new AppError(
      "NO_SONG_PATH",
      "Navidrome did not return a file path for this song",
      422
    );
  }

  const targetPath = song.path.replace(/\.[^.]+$/, ".lrc");
  const config = getConfig();
  const libraryRoot = config.LIBRARY_MUSIC_PATH?.trim();

  if (dry_run) {
    return c.json({
      dry_run: true,
      lrclib_id: track.id,
      navidrome_song_id,
      song: { artist: song.artist, title: song.title, album: song.album },
      target_path: targetPath,
      has_synced: !!track.syncedLyrics,
      has_plain: !!track.plainLyrics,
      lyrics_type: lyrics ? "synced" : "plain",
      lyrics_length: lrcContent.length,
      library_writable: libraryRoot ? isPathWritable(libraryRoot) : false,
    });
  }

  // Try writing to the library directly
  let status: "deployed" | "staged" = "staged";
  let stagedPath: string | null = null;

  if (libraryRoot && isPathWritable(libraryRoot)) {
    try {
      const fullPath = targetPath;
      if (existsSync(fullPath)) {
        throw new AppError(
          "LRC_EXISTS",
          `A .lrc file already exists at ${fullPath}. Use overwrite=true to replace.`,
          409
        );
      }

      writeFileSync(fullPath, lrcContent, "utf-8");
      status = "deployed";

      log("info", "lyric_deployed", {
        lrclib_id: track.id,
        navidrome_song_id,
        path: fullPath,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      log("warn", "lyric_deploy_failed", {
        error: err instanceof Error ? err.message : String(err),
        target_path: targetPath,
      });
      status = "staged";
    }
  }

  // Stage to data dir as fallback or backup
  if (status === "staged") {
    const stagingDir = join(dirname(config.DATABASE_PATH), "lyrics-staging");
    try {
      mkdirSync(stagingDir, { recursive: true });
    } catch {
      // may already exist
    }
    const safeName = `${navidrome_song_id}_${track.id}.lrc`;
    stagedPath = join(stagingDir, safeName);
    try {
      writeFileSync(stagedPath, lrcContent, "utf-8");
    } catch (err) {
      log("warn", "lyric_staging_failed", {
        error: err instanceof Error ? err.message : String(err),
        staged_path: stagedPath,
      });
      stagedPath = null;
    }
  }

  const record = createLyricAcquisition({
    navidromeSongId: navidrome_song_id,
    artist: track.artistName,
    title: track.trackName,
    album: track.albumName,
    lrclibId: track.id,
    matchType: "acquired",
    matchConfidence: 1.0,
    hasSynced: !!track.syncedLyrics,
    hasPlain: !!track.plainLyrics,
    syncedLyrics: track.syncedLyrics ?? undefined,
    plainLyrics: track.plainLyrics ?? undefined,
    targetPath,
    stagedPath: stagedPath ?? undefined,
    status,
  });

  if (status === "deployed") {
    try {
      await navidrome.startScan();
    } catch {
      // best-effort rescan
    }
  }

  return c.json({
    id: record.id,
    status,
    lrclib_id: track.id,
    navidrome_song_id,
    song: { artist: song.artist, title: song.title, album: song.album },
    target_path: targetPath,
    staged_path: stagedPath,
    lyrics_type: lyrics ? "synced" : "plain",
    library_note: status === "staged"
      ? "Library is read-only. Lyrics staged to data dir. Change compose mount to :rw to enable direct deployment."
      : undefined,
  }, status === "deployed" ? 201 : 200);
});

// --- POST /lyrics/audit ---

const auditSchema = z.object({
  navidrome_album_id: z.string().min(1).max(200).optional(),
  artist: z.string().min(1).max(500).optional(),
  album: z.string().min(1).max(500).optional(),
}).refine(
  (d) => d.navidrome_album_id || (d.artist && d.album),
  "Provide navidrome_album_id or both artist and album"
);

lyricsRoutes.post("/lyrics/audit", async (c) => {
  const body = await c.req.json();
  const parsed = auditSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const params = parsed.data;

  let albumData: { album: navidrome.LibraryAlbum; songs: navidrome.LibrarySong[] };

  if (params.navidrome_album_id) {
    albumData = await navidrome.getAlbum(params.navidrome_album_id);
  } else {
    const results = await navidrome.search3(
      `${params.artist} ${params.album}`,
      { albumCount: 10, songCount: 0 }
    );

    const match = results.albums[0];
    if (!match) {
      throw new AppError("NOT_FOUND", "Album not found in Navidrome", 404);
    }
    albumData = await navidrome.getAlbum(match.id);
  }

  const { album, songs } = albumData;
  const config = getConfig();
  const libraryRoot = config.LIBRARY_MUSIC_PATH?.trim();
  const canCheckFs = !!libraryRoot && existsSync(libraryRoot);

  const trackStatuses: TrackLyricStatus[] = [];
  let syncedCount = 0;
  let missingCount = 0;

  for (const song of songs) {
    const status = await auditSingleTrack(song, canCheckFs);
    trackStatuses.push(status);
    if (status.lrc_status === "present_synced") syncedCount++;
    if (status.lrc_status === "missing") missingCount++;
  }

  const coverage = songs.length > 0 ? syncedCount / songs.length : 0;

  return c.json({
    album: {
      navidrome_id: album.id,
      artist: album.artist,
      title: album.title,
      year: album.year,
      song_count: songs.length,
    },
    coverage: {
      synced: syncedCount,
      missing: missingCount,
      total: songs.length,
      ratio: Math.round(coverage * 100) / 100,
    },
    tracks: trackStatuses,
  });
});

// --- POST /lyrics/fill ---

const fillSchema = z.object({
  navidrome_album_id: z.string().min(1).max(200),
  synced_only: z.boolean().optional().default(true),
  min_confidence: z.number().min(0).max(1).optional().default(0.8),
  dry_run: z.boolean().optional().default(true),
});

lyricsRoutes.post("/lyrics/fill", async (c) => {
  const body = await c.req.json();
  const parsed = fillSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { navidrome_album_id, synced_only, min_confidence, dry_run } = parsed.data;

  const { album, songs } = await navidrome.getAlbum(navidrome_album_id);

  const results: FillResult[] = [];
  let filled = 0;
  let skipped = 0;
  let failed = 0;

  for (const song of songs) {
    // Check if .lrc already exists on filesystem
    if (song.path) {
      const lrcPath = song.path.replace(/\.[^.]+$/, ".lrc");
      if (existsSync(lrcPath)) {
        results.push({
          track: song.track ?? 0,
          title: song.title,
          status: "already_present",
          lrc_path: lrcPath,
        });
        skipped++;
        continue;
      }
    }

    // Check if we already acquired lyrics for this song
    const existing = getLyricAcquisitionBySong(song.id);
    if (existing && existing.status === "deployed") {
      results.push({
        track: song.track ?? 0,
        title: song.title,
        status: "already_acquired",
        acquisition_id: existing.id,
      });
      skipped++;
      continue;
    }

    // Search LRCLIB
    const matches = await lrclib.findBestMatches({
      artist: song.artist,
      title: song.title,
      album: song.album,
      durationS: song.duration,
      maxResults: 3,
    });

    const best = matches.find((m) =>
      m.confidence >= min_confidence &&
      (!synced_only || m.hasSynced)
    );

    if (!best) {
      const topMatch = matches[0];
      results.push({
        track: song.track ?? 0,
        title: song.title,
        status: "no_match",
        reason: matches.length === 0
          ? "no_results"
          : synced_only && topMatch && !topMatch.hasSynced
            ? "no_synced_available"
            : `best_confidence_${topMatch?.confidence ?? 0}`,
      });
      failed++;
      continue;
    }

    if (dry_run) {
      results.push({
        track: song.track ?? 0,
        title: song.title,
        status: "would_fill",
        lrclib_id: best.lrclibId,
        confidence: best.confidence,
        match_type: best.matchType,
        has_synced: best.hasSynced,
        lrclib_title: best.trackName,
        lrclib_artist: best.artistName,
        duration_delta_s: best.durationDeltaS >= 0 ? best.durationDeltaS : undefined,
      });
      filled++;
      continue;
    }

    // Acquire
    const lrcContent = best.syncedLyrics ?? best.plainLyrics;
    if (!lrcContent) {
      results.push({
        track: song.track ?? 0,
        title: song.title,
        status: "empty_lyrics",
      });
      failed++;
      continue;
    }

    let status: "deployed" | "staged" = "staged";
    let stagedPath: string | null = null;
    const targetPath = song.path?.replace(/\.[^.]+$/, ".lrc");
    const config = getConfig();

    if (targetPath && isPathWritable(dirname(targetPath))) {
      try {
        writeFileSync(targetPath, lrcContent, "utf-8");
        status = "deployed";
      } catch {
        status = "staged";
      }
    }

    if (status === "staged" && targetPath) {
      const stagingDir = join(dirname(config.DATABASE_PATH), "lyrics-staging");
      try { mkdirSync(stagingDir, { recursive: true }); } catch {}
      const safeName = `${song.id}_${best.lrclibId}.lrc`;
      stagedPath = join(stagingDir, safeName);
      try {
        writeFileSync(stagedPath, lrcContent, "utf-8");
      } catch {
        stagedPath = null;
      }
    }

    createLyricAcquisition({
      navidromeSongId: song.id,
      artist: best.artistName,
      title: best.trackName,
      album: best.albumName,
      lrclibId: best.lrclibId,
      matchType: best.matchType,
      matchConfidence: best.confidence,
      durationDeltaS: best.durationDeltaS >= 0 ? best.durationDeltaS : undefined,
      hasSynced: best.hasSynced,
      hasPlain: best.hasPlain,
      syncedLyrics: best.syncedLyrics ?? undefined,
      plainLyrics: best.plainLyrics ?? undefined,
      targetPath,
      stagedPath: stagedPath ?? undefined,
      status,
    });

    results.push({
      track: song.track ?? 0,
      title: song.title,
      status,
      lrclib_id: best.lrclibId,
      confidence: best.confidence,
      target_path: targetPath,
      staged_path: stagedPath ?? undefined,
    });
    filled++;
  }

  if (!dry_run && filled > 0) {
    try {
      await navidrome.startScan();
    } catch {}
  }

  log("info", "lyrics_fill", {
    album_id: navidrome_album_id,
    album: album.title,
    artist: album.artist,
    total: songs.length,
    filled,
    skipped,
    failed,
    dry_run,
  });

  return c.json({
    album: {
      navidrome_id: album.id,
      artist: album.artist,
      title: album.title,
    },
    dry_run,
    summary: { total: songs.length, filled, skipped, failed },
    tracks: results,
  });
});

// --- helpers ---

interface TrackLyricStatus {
  track: number;
  title: string;
  navidrome_id: string;
  duration_s: number;
  lrc_status: "present_synced" | "present_plain" | "missing" | "unknown";
  lrc_path?: string;
  lrclib_available?: boolean;
  lrclib_best_confidence?: number;
  lrclib_has_synced?: boolean;
}

interface FillResult {
  track: number;
  title: string;
  status: string;
  lrc_path?: string;
  acquisition_id?: string;
  reason?: string;
  lrclib_id?: number;
  confidence?: number;
  match_type?: string;
  has_synced?: boolean;
  lrclib_title?: string;
  lrclib_artist?: string;
  duration_delta_s?: number;
  target_path?: string;
  staged_path?: string;
}

async function auditSingleTrack(
  song: navidrome.LibrarySong,
  canCheckFs: boolean
): Promise<TrackLyricStatus> {
  let lrcStatus: TrackLyricStatus["lrc_status"] = "unknown";
  let lrcPath: string | undefined;

  if (canCheckFs && song.path) {
    const lrcFile = song.path.replace(/\.[^.]+$/, ".lrc");
    if (existsSync(lrcFile)) {
      lrcStatus = "present_synced";
      lrcPath = lrcFile;
    } else {
      lrcStatus = "missing";
    }
  } else {
    lrcStatus = "unknown";
  }

  // Check LRCLIB availability for missing tracks
  let lrclibAvailable: boolean | undefined;
  let lrclibBestConfidence: number | undefined;
  let lrclibHasSynced: boolean | undefined;

  if (lrcStatus === "missing" || lrcStatus === "unknown") {
    try {
      const matches = await lrclib.findBestMatches({
        artist: song.artist,
        title: song.title,
        album: song.album,
        durationS: song.duration,
        maxResults: 1,
      });

      if (matches.length > 0) {
        lrclibAvailable = true;
        lrclibBestConfidence = matches[0]!.confidence;
        lrclibHasSynced = matches[0]!.hasSynced;
      } else {
        lrclibAvailable = false;
      }
    } catch {
      // LRCLIB unavailable, leave as undefined
    }
  }

  return {
    track: song.track ?? 0,
    title: song.title,
    navidrome_id: song.id,
    duration_s: song.duration,
    lrc_status: lrcStatus,
    lrc_path: lrcPath,
    lrclib_available: lrclibAvailable,
    lrclib_best_confidence: lrclibBestConfidence,
    lrclib_has_synced: lrclibHasSynced,
  };
}

function serializeMatch(m: lrclib.LrclibMatch) {
  return {
    lrclib_id: m.lrclibId,
    artist: m.artistName,
    title: m.trackName,
    album: m.albumName,
    duration_s: m.durationS,
    duration_delta_s: m.durationDeltaS >= 0 ? m.durationDeltaS : null,
    instrumental: m.instrumental,
    has_synced: m.hasSynced,
    has_plain: m.hasPlain,
    match_type: m.matchType,
    confidence: m.confidence,
  };
}

function isPathWritable(path: string): boolean {
  try {
    const testFile = join(path, `.write-test-${Date.now()}`);
    writeFileSync(testFile, "", "utf-8");
    unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}
