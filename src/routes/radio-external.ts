import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { importExternalGeneration } from "../services/radio-import";

export const radioExternalRoutes = new Hono();

const trackSchema = z.object({
  artist: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  album: z.string().max(500).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  spotifyId: z.string().max(128).nullable().optional(),
  navidromeId: z.string().max(128).nullable().optional(),
  isrc: z.string().max(32).nullable().optional(),
});

radioExternalRoutes.post("/radio/generations/:id/import-external", async (c) => {
  const { tracks } = z.object({ tracks: z.array(trackSchema).max(500) }).parse(await c.req.json());
  const generation = await importExternalGeneration(c.req.param("id"), tracks);
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(generation);
});
