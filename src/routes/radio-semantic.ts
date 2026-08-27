import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  createRadio,
  generateStation,
  listRadioStations,
  presentGeneration,
  presentStation,
  recordRadioFeedback,
} from "../services/radio";

export const radioSemanticRoutes = new Hono();

const seedSchema = z.object({
  type: z.enum(["track", "artist", "album", "genre", "playlist", "liked", "library", "collection"]),
  entityId: z.string().max(256).nullable().optional(),
  artist: z.string().max(300).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  label: z.string().min(1).max(500),
  weight: z.number().positive().max(100).optional(),
  position: z.number().min(0).max(100).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const partialSettingsSchema = z.object({
  length: z.number().int().min(1).max(200).optional(),
  familiarity: z.number().min(0).max(1).optional(),
  knownBias: z.number().min(-1).max(1).optional(),
  ownedBias: z.number().min(-1).max(1).optional(),
  sameArtistBias: z.number().min(-1).max(1).optional(),
  popularityBias: z.number().min(-1).max(1).optional(),
  releaseAgeBias: z.number().min(-1).max(1).optional(),
  genreSimilarity: z.number().min(0).max(1).optional(),
  seedArtistFrequency: z.number().min(0).max(1).optional(),
  artistCooldown: z.number().int().min(0).max(100).optional(),
  trackCooldown: z.number().int().min(0).max(10000).optional(),
  repeatStrength: z.number().min(0).max(2).optional(),
  surprise: z.number().min(0).max(1).optional(),
  djFlow: z.number().min(0).max(1).optional(),
  providerWeights: z.record(z.number().min(0).max(5)).optional(),
  djWeights: z.record(z.number().min(0).max(5)).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["standard", "gradient"]).optional(),
  seeds: z.array(seedSchema).min(1).max(50),
  settings: partialSettingsSchema.optional(),
  generate: z.boolean().optional(),
});

const feedbackSchema = z.object({
  scope: z.enum(["station", "global"]),
  stationId: z.string().nullable().optional(),
  entityType: z.enum(["track", "artist"]),
  entityKey: z.string().min(1).max(1000),
  action: z.enum(["more_like", "less_like", "ban_station", "rank_down_global", "ban_track_global", "ban_artist_global"]),
  strength: z.number().min(0.1).max(5).optional(),
});

radioSemanticRoutes.get("/radio/stations", (c) => c.json({ stations: listRadioStations() }));

radioSemanticRoutes.post("/radio/stations", async (c) => {
  const input = createSchema.parse(await c.req.json());
  return c.json(await createRadio(input), 201);
});

radioSemanticRoutes.get("/radio/stations/:id", (c) => {
  const station = presentStation(c.req.param("id"));
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioSemanticRoutes.post("/radio/stations/:id/generate", async (c) => {
  if (!presentStation(c.req.param("id"))) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  const body = z.object({ length: z.number().int().min(1).max(200).optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await generateStation(c.req.param("id"), body), 201);
});

radioSemanticRoutes.get("/radio/generations/:id", (c) => {
  const generation = presentGeneration(c.req.param("id"));
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(generation);
});

radioSemanticRoutes.post("/radio/feedback", async (c) => {
  const input = feedbackSchema.parse(await c.req.json());
  if (input.scope === "station" && !input.stationId) {
    throw new AppError("VALIDATION_ERROR", "stationId is required for station feedback", 400);
  }
  return c.json({ feedback: recordRadioFeedback(input) }, 201);
});
