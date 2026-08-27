import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { generateLiveRadioBatch } from "../services/radio-live";

export const radioLiveSemanticRoutes = new Hono();

const liveSchema = z.object({
  count: z.number().int().min(4).max(30).optional(),
  excludeKeys: z.array(z.string().min(1).max(1000)).max(5000).optional(),
  routeCursor: z.number().min(0).max(1).nullable().optional(),
});

radioLiveSemanticRoutes.post("/radio/stations/:id/live-batch", async (c) => {
  const input = liveSchema.parse(await c.req.json().catch(() => ({})));
  const batch = await generateLiveRadioBatch(c.req.param("id"), input);
  if (!batch) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(batch);
});