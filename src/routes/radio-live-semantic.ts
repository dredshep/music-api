import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { generateLiveRadioBatch } from "../services/radio-live";

export const radioLiveSemanticRoutes = new Hono();

const liveRouteTrackSchema = z.object({
  id: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  canonical_key: z.string().min(1).max(1000),
  artist: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  album: z.string().max(500).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  isrc: z.string().max(64).nullable(),
  spotify_id: z.string().max(128).nullable(),
  navidrome_id: z.string().max(128).nullable(),
  musicbrainz_id: z.string().max(128).nullable(),
  playback_source: z.string().max(64).nullable(),
  availability: z.string().max(64),
  pinned: z.boolean(),
  manual: z.boolean(),
  score: z.number(),
  trajectory_position: z.number().min(0).max(1).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const liveRouteStateSchema = z.object({
  version: z.literal(1),
  station_id: z.string().min(1).max(200),
  generator_version: z.string().min(1).max(200),
  tracks: z.array(liveRouteTrackSchema).max(200),
  next_index: z.number().int().nonnegative().max(200),
  previous_key: z.string().max(1000).nullable(),
  completed: z.boolean(),
});

const liveSchema = z.object({
  count: z.number().int().min(4).max(30).optional(),
  excludeKeys: z.array(z.string().min(1).max(1000)).max(5000).optional(),
  routeCursor: z.number().min(0).max(1).nullable().optional(),
  routeState: liveRouteStateSchema.nullable().optional(),
});

radioLiveSemanticRoutes.post("/radio/stations/:id/live-batch", async (c) => {
  const input = liveSchema.parse(await c.req.json().catch(() => ({})));
  const batch = await generateLiveRadioBatch(c.req.param("id"), input);
  if (!batch) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(batch);
});
