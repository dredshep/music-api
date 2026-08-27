import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  createRadio,
  listRadioStations,
  presentGeneration,
  presentStation,
  recordRadioFeedback,
} from "../services/radio";
import { generateRadioStationWithGradient } from "../services/radio-gradient-generation";
import { hydrateNativeRadioSeeds, refreshNativeRadioSeedSnapshots } from "../services/radio-native-seeds";
import { finalizeRadioGeneration } from "../services/radio-finalize";

export const radioSemanticRoutes = new Hono();

const seedBase = {
  entityId: z.string().max(256).nullable().optional(),
  label: z.string().min(1).max(500),
  weight: z.number().positive().max(100).optional(),
  position: z.number().min(0).max(1).nullable().optional(),
};

const seedSchema = z.discriminatedUnion("type", [
  z.object({ ...seedBase, type: z.literal("track"), artist: z.string().min(1).max(300), title: z.string().min(1).max(500) }),
  z.object({ ...seedBase, type: z.literal("artist"), artist: z.string().min(1).max(300) }),
  z.object({ ...seedBase, type: z.literal("album"), artist: z.string().min(1).max(300), title: z.string().min(1).max(500) }),
  z.object({ ...seedBase, type: z.literal("genre") }),
  z.object({ ...seedBase, type: z.literal("library") }),
]);

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
  gradientAlgorithm: z.enum(["blend", "geodesic", "scenic"]).optional(),
  gradientRouteStrength: z.number().min(0).max(8).optional(),
  gradientRouteWidth: z.number().min(0.05).max(0.6).optional(),
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
  const result = await createRadio({ ...input, seeds: await hydrateNativeRadioSeeds(input.seeds), generate: false });
  if (input.generate !== false) {
    const stationId = result.station?.id;
    if (!stationId) throw new AppError("RADIO_CREATE_FAILED", "Radio station was not created", 500);
    const generation = await generateRadioStationWithGradient(stationId);
    result.generation = await finalizeRadioGeneration(generation.id);
  }
  return c.json(result, 201);
});

radioSemanticRoutes.get("/radio/stations/:id", (c) => {
  const station = presentStation(c.req.param("id"));
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioSemanticRoutes.post("/radio/stations/:id/generate", async (c) => {
  const stationId = c.req.param("id");
  if (!presentStation(stationId)) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  const body = z.object({ length: z.number().int().min(1).max(200).optional() }).parse(await c.req.json().catch(() => ({})));
  await refreshNativeRadioSeedSnapshots(stationId);
  const generation = await generateRadioStationWithGradient(stationId, body);
  return c.json(await finalizeRadioGeneration(generation.id), 201);
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
