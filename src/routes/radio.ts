import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  createRadio,
  DEFAULT_RADIO_SETTINGS,
  generateStation,
  listRadioStations,
  pinGenerationTrack,
  presentGeneration,
  presentStation,
  recordRadioFeedback,
  regenerateTail,
  removeGenerationTrack,
  removeRadioStation,
  updateRadioStation,
} from "../services/radio";

export const radioRoutes = new Hono();

const tasteTrackSchema = z.object({
  artist: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  album: z.string().max(500).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  isrc: z.string().max(32).nullable().optional(),
  spotifyId: z.string().max(128).nullable().optional(),
  weight: z.number().min(0).max(10).optional(),
});

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
  tasteProfile: z.array(tasteTrackSchema).max(5000).optional(),
  generate: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(["standard", "gradient"]).optional(),
  seeds: z.array(seedSchema).min(1).max(50).optional(),
  settings: partialSettingsSchema.optional(),
});

const generateSchema = z.object({
  length: z.number().int().min(1).max(200).optional(),
  tasteProfile: z.array(tasteTrackSchema).max(5000).optional(),
}).optional();

const regenerateSchema = z.object({
  fromPosition: z.number().int().min(0).max(199),
  tasteProfile: z.array(tasteTrackSchema).max(5000).optional(),
});

const feedbackSchema = z.object({
  scope: z.enum(["station", "global"]),
  stationId: z.string().nullable().optional(),
  entityType: z.enum(["track", "artist"]),
  entityKey: z.string().min(1).max(1000),
  action: z.enum(["more_like", "less_like", "ban_station", "rank_down_global", "ban_track_global", "ban_artist_global"]),
  strength: z.number().min(0.1).max(5).optional(),
});

radioRoutes.get("/radio/defaults", (c) => c.json({ settings: DEFAULT_RADIO_SETTINGS }));

radioRoutes.get("/radio/stations", (c) => c.json({ stations: listRadioStations() }));

radioRoutes.post("/radio/stations", async (c) => {
  const input = createSchema.parse(await c.req.json());
  const result = await createRadio(input);
  return c.json(result, 201);
});

radioRoutes.get("/radio/stations/:id", (c) => {
  const station = presentStation(c.req.param("id"));
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioRoutes.patch("/radio/stations/:id", async (c) => {
  const patch = updateSchema.parse(await c.req.json());
  const station = updateRadioStation(c.req.param("id"), patch);
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioRoutes.delete("/radio/stations/:id", (c) => {
  if (!removeRadioStation(c.req.param("id"))) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json({ ok: true });
});

radioRoutes.post("/radio/stations/:id/generate", async (c) => {
  if (!presentStation(c.req.param("id"))) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  const input = generateSchema.parse(await c.req.json().catch(() => ({}))) ?? {};
  return c.json(await generateStation(c.req.param("id"), input), 201);
});

radioRoutes.get("/radio/generations/:id", (c) => {
  const generation = presentGeneration(c.req.param("id"));
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(generation);
});

radioRoutes.post("/radio/generations/:id/regenerate-tail", async (c) => {
  if (!presentGeneration(c.req.param("id"))) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  const input = regenerateSchema.parse(await c.req.json());
  return c.json(await regenerateTail(c.req.param("id"), input.fromPosition, input.tasteProfile));
});

radioRoutes.post("/radio/generations/:id/tracks/:trackId/pin", async (c) => {
  const body = z.object({ pinned: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
  if (!pinGenerationTrack(c.req.param("id"), c.req.param("trackId"), body.pinned)) {
    throw new AppError("RADIO_TRACK_NOT_FOUND", "Radio generation track not found", 404);
  }
  return c.json(presentGeneration(c.req.param("id")));
});

radioRoutes.delete("/radio/generations/:id/tracks/:trackId", (c) => {
  if (!removeGenerationTrack(c.req.param("id"), c.req.param("trackId"))) {
    throw new AppError("RADIO_TRACK_NOT_FOUND", "Radio generation track not found", 404);
  }
  return c.json(presentGeneration(c.req.param("id")));
});

radioRoutes.post("/radio/feedback", async (c) => {
  const input = feedbackSchema.parse(await c.req.json());
  if (input.scope === "station" && !input.stationId) throw new AppError("VALIDATION_ERROR", "stationId is required for station feedback", 400);
  return c.json({ feedback: recordRadioFeedback(input) }, 201);
});
