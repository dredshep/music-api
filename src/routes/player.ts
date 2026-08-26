import { Hono } from "hono";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getConfig } from "../config";
import { AppError } from "../middleware/errors";
import * as navidromePlayer from "../services/navidrome-player";
import { canSubmitListen, submitSingleListen } from "../services/listenbrainz-submit";

export const playerRoutes = new Hono();

function intQuery(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, min), max);
}

function copyMediaHeaders(upstream: Response, extra?: HeadersInit) {
  const headers = new Headers(extra);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function mediaResponse(upstream: Response, extra?: HeadersInit) {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyMediaHeaders(upstream, extra),
  });
}

playerRoutes.get("/player/stream/:id", async (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format") === "mp3" ? "mp3" : "raw";
  const maxBitRate = intQuery(c.req.query("maxBitRate"), 320, 32, 320);
  const upstream = await navidromePlayer.streamSong(id, {
    range: c.req.header("range"),
    format,
    maxBitRate,
  });
  return mediaResponse(upstream, { "Cache-Control": "private, no-store" });
});

playerRoutes.get("/player/download/:id", async (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format") === "mp3" ? "mp3" : "raw";
  const maxBitRate = intQuery(c.req.query("maxBitRate"), 320, 32, 320);
  const song = await navidromePlayer.getSong(id);
  const upstream =
    format === "mp3"
      ? await navidromePlayer.streamSong(id, { range: c.req.header("range"), format, maxBitRate })
      : await navidromePlayer.downloadSong(id, c.req.header("range"));
  const safeBase = `${song.artist} - ${song.title}`.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
  const suffix = format === "mp3" ? "mp3" : song.suffix || "audio";
  return mediaResponse(upstream, {
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${safeBase}.${suffix}`)}`,
    "Cache-Control": "private, no-store",
  });
});

playerRoutes.get("/player/cover/:id", async (c) => {
  const size = intQuery(c.req.query("size"), 512, 32, 1600);
  const upstream = await navidromePlayer.coverArt(c.req.param("id"), size);
  return mediaResponse(upstream, { "Cache-Control": "private, max-age=86400" });
});

playerRoutes.get("/player/song/:id", async (c) => {
  return c.json(await navidromePlayer.getSong(c.req.param("id")));
});

playerRoutes.get("/player/lyrics/:id", async (c) => {
  return c.json({ sources: await navidromePlayer.getLyrics(c.req.param("id")) });
});

const scrobbleSchema = z.object({
  navidrome_id: z.string().min(1).max(300).optional(),
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  listened_at: z.number().int().positive().optional(),
  recording_mbid: z.string().uuid().optional(),
});

playerRoutes.post("/player/scrobble", async (c) => {
  const parsed = scrobbleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  const listen = parsed.data;

  if (listen.navidrome_id) {
    await navidromePlayer.scrobble(
      listen.navidrome_id,
      listen.listened_at ? listen.listened_at * 1000 : Date.now(),
    );
    return c.json({ scrobbled: true, target: "navidrome" });
  }

  if (canSubmitListen()) {
    await submitSingleListen({
      artist: listen.artist,
      title: listen.title,
      album: listen.album,
      listenedAt: listen.listened_at,
      recordingMbid: listen.recording_mbid,
    });
    return c.json({ scrobbled: true, target: "listenbrainz" });
  }

  return c.json({ scrobbled: false, target: "local_only" });
});

const starSchema = z.object({
  ids: z.array(z.string().min(1).max(300)).min(1).max(500),
  starred: z.boolean(),
});

playerRoutes.post("/player/star", async (c) => {
  const parsed = starSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  await navidromePlayer.setStarred(parsed.data.ids, parsed.data.starred);
  return c.json({ ok: true, count: parsed.data.ids.length, starred: parsed.data.starred });
});

playerRoutes.get("/library/songs", async (c) => {
  return c.json(
    await navidromePlayer.listSongs({
      query: c.req.query("q") ?? "",
      limit: intQuery(c.req.query("limit"), 200, 1, 500),
      offset: intQuery(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    }),
  );
});

playerRoutes.get("/library/albums", async (c) => {
  const allowedSorts = new Set([
    "alphabeticalByArtist",
    "alphabeticalByName",
    "recent",
    "newest",
    "frequent",
    "random",
  ]);
  const requestedSort = c.req.query("sort") ?? "alphabeticalByArtist";
  const sort = allowedSorts.has(requestedSort)
    ? (requestedSort as "alphabeticalByArtist" | "alphabeticalByName" | "recent" | "newest" | "frequent" | "random")
    : "alphabeticalByArtist";
  return c.json(
    await navidromePlayer.listAlbums({
      limit: intQuery(c.req.query("limit"), 100, 1, 500),
      offset: intQuery(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
      sort,
      genre: c.req.query("genre")?.trim() || undefined,
    }),
  );
});

playerRoutes.get("/library/albums/:id", async (c) => {
  return c.json(await navidromePlayer.getAlbum(c.req.param("id")));
});

playerRoutes.get("/library/artists/:id", async (c) => {
  return c.json(await navidromePlayer.getArtist(c.req.param("id")));
});

playerRoutes.get("/library/starred", async (c) => {
  const songs = await navidromePlayer.listStarredSongs();
  return c.json({ songs, total: songs.length });
});

playerRoutes.get("/library/genres", async (c) => {
  const genres = await navidromePlayer.listGenres();
  return c.json({ genres, total: genres.length });
});

function configuredLibraryRoot(): string {
  const raw = getConfig().LIBRARY_MUSIC_PATH?.trim();
  if (!raw) throw new AppError("LIBRARY_NOT_WRITABLE", "LIBRARY_MUSIC_PATH is not configured", 422);
  if (!existsSync(raw)) throw new AppError("LIBRARY_NOT_WRITABLE", "LIBRARY_MUSIC_PATH does not exist", 422);
  return realpathSync(raw);
}

function safeLibraryFilePath(libraryRoot: string, songPath: string): string {
  const root = realpathSync(libraryRoot);
  const candidate = isAbsolute(songPath) ? resolve(songPath) : resolve(root, songPath);
  const parent = dirname(candidate);
  if (!existsSync(parent)) throw new AppError("NO_SONG_PATH", "Song parent directory no longer exists", 404);
  const realParent = realpathSync(parent);
  const relParent = relative(root, realParent);
  if (relParent === ".." || relParent.startsWith(`..${sep}`) || isAbsolute(relParent)) {
    throw new AppError("INVALID_LIBRARY_PATH", "Navidrome song path resolves outside LIBRARY_MUSIC_PATH", 422);
  }
  const safe = join(realParent, candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  const rel = relative(root, safe);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AppError("INVALID_LIBRARY_PATH", "Navidrome song path is outside LIBRARY_MUSIC_PATH", 422);
  }
  return safe;
}

function targetSidecarPath(libraryRoot: string, songPath: string): string {
  return safeLibraryFilePath(libraryRoot, songPath).replace(/\.[^.]+$/, ".lrc");
}

const deleteLibrarySchema = z.object({
  entity: z.enum(["track", "album", "artist"]),
  id: z.string().min(1).max(300),
  confirm: z.literal(true),
});

type DeleteCandidate = { id: string; artist: string; album: string; title: string; path?: string };

async function songsForDeletion(entity: "track" | "album" | "artist", id: string): Promise<DeleteCandidate[]> {
  if (entity === "track") return [await navidromePlayer.getSong(id)];
  if (entity === "album") return (await navidromePlayer.getAlbum(id)).songs;
  const { albums } = await navidromePlayer.getArtist(id);
  const songs: DeleteCandidate[] = [];
  for (const album of albums) songs.push(...(await navidromePlayer.getAlbum(album.id)).songs);
  return songs;
}

function pruneEmptyParents(start: string, root: string) {
  let cursor = dirname(start);
  while (cursor !== root) {
    const rel = relative(root, cursor);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    try {
      rmdirSync(cursor);
    } catch {
      return;
    }
    cursor = dirname(cursor);
  }
}

playerRoutes.post("/library/delete", async (c) => {
  const parsed = deleteLibrarySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "), 400);
  }

  const root = configuredLibraryRoot();
  const candidates = await songsForDeletion(parsed.data.entity, parsed.data.id);
  if (!candidates.length) throw new AppError("NOT_FOUND", "No local tracks resolved for this entity", 404);

  const resolved = [];
  for (const song of candidates) {
    // Subsonic path is virtual; resolve the real library-relative path for FS ops.
    const libraryPath = await navidromePlayer.getSongLibraryPath(song.id);
    const audioPath = safeLibraryFilePath(root, libraryPath);
    resolved.push({
      song,
      audioPath,
      sidecarPath: audioPath.replace(/\.[^.]+$/, ".lrc"),
    });
  }

  const unique = new Map(resolved.map((item) => [item.audioPath, item]));
  const deleted: Array<{ id: string; path: string; sidecar_deleted: boolean }> = [];
  for (const item of unique.values()) {
    if (existsSync(item.audioPath)) rmSync(item.audioPath, { force: false });
    const sidecarDeleted = existsSync(item.sidecarPath);
    if (sidecarDeleted) rmSync(item.sidecarPath, { force: true });
    deleted.push({ id: item.song.id, path: item.audioPath, sidecar_deleted: sidecarDeleted });
    pruneEmptyParents(item.audioPath, root);
  }

  return c.json({
    deleted: true,
    entity: parsed.data.entity,
    id: parsed.data.id,
    tracks_deleted: deleted.length,
    files: deleted,
    note: "Navidrome will reflect filesystem deletion after its next scan.",
  });
});

const sidecarSchema = z.object({
  navidrome_song_id: z.string().min(1).max(300),
  content: z.string().min(1).max(2_000_000),
  overwrite: z.boolean().optional().default(false),
});

playerRoutes.post("/player/lyrics/sidecar", async (c) => {
  const parsed = sidecarSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  const { navidrome_song_id, content, overwrite } = parsed.data;
  const config = getConfig();
  const libraryRoot = config.LIBRARY_MUSIC_PATH?.trim();
  if (!libraryRoot) {
    throw new AppError("LIBRARY_NOT_WRITABLE", "LIBRARY_MUSIC_PATH is not configured", 422);
  }
  // Subsonic path is virtual; resolve the real library-relative path for FS ops.
  const libraryPath = await navidromePlayer.getSongLibraryPath(navidrome_song_id);
  const target = targetSidecarPath(libraryRoot, libraryPath);
  if (existsSync(target) && !overwrite) {
    throw new AppError("LRC_EXISTS", "A .lrc sidecar already exists; retry with overwrite=true to replace it", 409);
  }

  let status: "deployed" | "staged" = "deployed";
  let stagedPath: string | null = null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  } catch {
    status = "staged";
    const staging = join(dirname(config.DATABASE_PATH), "lyrics-staging");
    mkdirSync(staging, { recursive: true });
    stagedPath = join(staging, `${navidrome_song_id}_${Date.now()}.lrc`);
    writeFileSync(stagedPath, content, "utf8");
  }

  return c.json({
    status,
    navidrome_song_id,
    target_path: target,
    staged_path: stagedPath,
    overwritten: overwrite && status === "deployed",
  }, status === "deployed" ? 201 : 200);
});