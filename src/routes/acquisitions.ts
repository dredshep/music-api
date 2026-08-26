import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  getAcquisitionSnapshot,
  startAcquisition,
} from "../services/acquisition-service";

export const acquisitionRoutes = new Hono();

const startSchema = z.object({
  artist: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  release_type: z.enum(["album", "ep", "single", "track"]),
  search_id: z.string().min(1).max(100),
  candidate_id: z.string().min(1).max(100),
  max_source_attempts: z.coerce.number().int().min(1).max(10).optional(),
});

acquisitionRoutes.post("/acquisitions", async (c) => {
  const parsed = startSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((issue) => issue.message).join("; "),
      400
    );
  }

  const body = parsed.data;
  const acquisition = await startAcquisition({
    artist: body.artist,
    title: body.title,
    releaseType: body.release_type,
    searchId: body.search_id,
    candidateId: body.candidate_id,
    maxSourceAttempts: body.max_source_attempts,
  });

  return c.json(acquisition, 202);
});

acquisitionRoutes.get("/acquisitions/:acquisition_id", (c) => {
  const acquisition = getAcquisitionSnapshot(c.req.param("acquisition_id"));
  if (!acquisition) {
    throw new AppError("DOWNLOAD_NOT_FOUND", "Acquisition not found", 404);
  }
  return c.json(acquisition);
});
