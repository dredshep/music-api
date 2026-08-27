import { Hono } from "hono";
import { AppError } from "../middleware/errors";
import { presentGeneration } from "../services/radio";
import { getAudioAnalysisQueueStatus, queueRadioGenerationAnalysis } from "../services/audio-analysis";

export const radioAnalysisRoutes = new Hono();

radioAnalysisRoutes.get("/radio/audio-analysis/status", (c) => c.json(getAudioAnalysisQueueStatus()));

radioAnalysisRoutes.post("/radio/generations/:id/analyze", (c) => {
  if (!presentGeneration(c.req.param("id"))) {
    throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  }
  return c.json(queueRadioGenerationAnalysis(c.req.param("id")), 202);
});
