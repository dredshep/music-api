import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { generateLiveRadioBatch } from "../services/radio-live";

export const radioLiveManagerRoutes = new Hono();

const tasteTrackSchema = z.object({
  artist: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  album: z.string().max(500).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  isrc: z.string().max(32).nullable().optional(),
  spotifyId: z.string().max(128).nullable().optional(),
  navidromeId: z.string().max(128).nullable().optional(),
  weight: z.number().min(0).max(10).optional(),
  source: z.enum(["spotify", "local_history"]).optional(),
  releaseYear: z.number().int().min(1900).max(2200).nullable().optional(),
  popularity: z.number().min(0).max(1).nullable().optional(),
});

const liveSchema = z.object({
  count: z.number().int().min(4).max(30).optional(),
  excludeKeys: z.array(z.string().min(1).max(1000)).max(5000).optional(),
  tasteProfile: z.array(tasteTrackSchema).max(5000).optional(),
  routeCursor: z.number().min(0).max(1).nullable().optional(),
});

radioLiveManagerRoutes.post("/radio/stations/:id/live-batch", async (c) => {
  const input = liveSchema.parse(await c.req.json().catch(() => ({})));
  const batch = await generateLiveRadioBatch(c.req.param("id"), input);
  if (!batch) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(batch);
});