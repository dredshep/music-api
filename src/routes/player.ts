import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import * as navidrome from "../services/navidrome";

export const playerRoutes = new Hono();

playerRoutes.get("/player/navidrome/:song_id/stream", async (c) => {
  const songId = c.req.param("song_id");
  if (!songId || songId.length > 500) {
    throw new AppError("VALIDATION_ERROR", "Invalid song id", 400);
  }

  const upstream = await navidrome.streamSong(songId, c.req.header("range"));
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});

const scrobbleSchema = z.object({
  song_id: z.string().min(1).max(500),
  submission: z.boolean().optional().default(false),
  time_ms: z.number().int().positive().optional(),
});

playerRoutes.post("/player/navidrome/scrobble", async (c) => {
  const parsed = scrobbleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((issue) => issue.message).join("; "),
      400
    );
  }

  await navidrome.scrobbleSong(
    parsed.data.song_id,
    parsed.data.submission,
    parsed.data.time_ms
  );

  return c.json({
    ok: true,
    song_id: parsed.data.song_id,
    submission: parsed.data.submission,
  });
});
