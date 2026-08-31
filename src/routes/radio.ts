import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  cloneGeneration,
  createRadio,
  DEFAULT_RADIO_SETTINGS,
  insertManualGenerationTrack,
  listGenerationRevisions,
  listRadioStations,
  pinGenerationTrack,
  presentGeneration,
  presentStation,
  recordRadioFeedback,
  removeGenerationTrack,
  removeRadioStation,
  reorderGenerationTracks,
  resolveGenerationTracks,
  revertGenerationRevision,
  updateRadioStation,
} from "../services/radio";
import {
  generateRadioStationWithGradient,
  regenerateRadioTailWithGradient,
} from "../services/radio-gradient-generation";
import { hydrateNativeRadioSeeds, refreshNativeRadioSeedSnapshots } from "../services/radio-native-seeds";
import { finalizeRadioGeneration } from "../services/radio-finalize";
import { syncRadioGenerationLengthToTracks } from "../services/radio-generation-metadata";

export const radioRoutes = new Hono();

const tasteTrackSchema = z.object({
  artist: z.string().min(1).max(300),
  title: z.string().min(1).max(500),
  album: z.string().max(500).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  isrc: z.string().max(32).nullable().optional(),
  spotifyId: z.string().max(128).nullable().optional(),
  weight: z.number().min(0).max(10).optional(),
  source: z.enum(["spotify", "local_history"]).optional(),
  releaseYear: z.number().int().min(1900).max(2200).nullable().optional(),
  popularity: z.number().min(0).max(1).nullable().optional(),
});

const seedSchema = z.object({
  type: z.enum(["track", "artist", "album", "genre", "playlist", "liked", "library", "collection"]),
  entityId: z.string().max(256).nullable().optional(),
  artist: z.string().max(300).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  label: z.string().min(1).max(500),
  weight: z.number().positive().max(100).optional(),
  position: z.number().min(0).max(1).nullable().optional(),
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

function normalizeSeedPositions<T extends { position?: number | null }>(seeds: T[], type: "standard" | "gradient"): T[] {
  if (type !== "gradient") return seeds;
  return seeds.map((seed, index) => ({
    ...seed,
    position: seed.position ?? (seeds.length <= 1 ? 0 : index / (seeds.length - 1)),
  }));
}

radioRoutes.get("/radio/defaults", (c) => c.json({ settings: DEFAULT_RADIO_SETTINGS }));
radioRoutes.get("/radio/stations", (c) => c.json({ stations: listRadioStations() }));

radioRoutes.post("/radio/stations", async (c) => {
  const input = createSchema.parse(await c.req.json());
  const hydrated = await hydrateNativeRadioSeeds(input.seeds);
  const result = await createRadio({ ...input, seeds: hydrated, generate: false });
  if (input.generate !== false) {
    const stationId = result.station?.id;
    if (!stationId) throw new AppError("RADIO_CREATE_FAILED", "Radio station was not created", 500);
    const generation = await generateRadioStationWithGradient(stationId, { tasteProfile: input.tasteProfile });
    result.generation = await finalizeRadioGeneration(generation.id);
  }
  return c.json(result, 201);
});

radioRoutes.get("/radio/stations/:id", (c) => {
  const station = presentStation(c.req.param("id"));
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioRoutes.patch("/radio/stations/:id", async (c) => {
  const stationId = c.req.param("id");
  const current = presentStation(stationId);
  if (!current) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  const patch = updateSchema.parse(await c.req.json());
  const hydratedSeeds = patch.seeds ? await hydrateNativeRadioSeeds(patch.seeds) : undefined;
  const seeds = hydratedSeeds ? normalizeSeedPositions(hydratedSeeds, patch.type ?? current.type) : undefined;
  const station = updateRadioStation(stationId, seeds ? { ...patch, seeds } : patch);
  if (!station) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json(station);
});

radioRoutes.delete("/radio/stations/:id", (c) => {
  if (!removeRadioStation(c.req.param("id"))) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  return c.json({ ok: true });
});

radioRoutes.post("/radio/stations/:id/generate", async (c) => {
  const stationId = c.req.param("id");
  if (!presentStation(stationId)) throw new AppError("RADIO_NOT_FOUND", "Radio station not found", 404);
  const input = generateSchema.parse(await c.req.json().catch(() => ({}))) ?? {};
  await refreshNativeRadioSeedSnapshots(stationId);
  const generation = await generateRadioStationWithGradient(stationId, input);
  return c.json(await finalizeRadioGeneration(generation.id), 201);
});

radioRoutes.get("/radio/generations/:id", (c) => {
  const generation = presentGeneration(c.req.param("id"));
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(generation);
});

radioRoutes.post("/radio/generations/:id/clone", async (c) => {
  const generation = cloneGeneration(c.req.param("id"));
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(await finalizeRadioGeneration(generation.id, { resequence: false }), 201);
});

radioRoutes.post("/radio/generations/:id/regenerate-tail", async (c) => {
  const generationId = c.req.param("id");
  const existing = presentGeneration(generationId);
  if (!existing) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  const input = regenerateSchema.parse(await c.req.json());
  await refreshNativeRadioSeedSnapshots(existing.station_id);
  const generation = await regenerateRadioTailWithGradient(generationId, input.fromPosition, input.tasteProfile);
  return c.json(await finalizeRadioGeneration(generation.id, { fromPosition: input.fromPosition }));
});

radioRoutes.post("/radio/generations/:id/resolve", async (c) => {
  const body = z.object({ resolutions: z.array(z.object({
    trackId: z.string().min(1),
    spotifyId: z.string().nullable().optional(),
    isrc: z.string().nullable().optional(),
    album: z.string().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    popularity: z.number().min(0).max(1).nullable().optional(),
    releaseYear: z.number().int().min(1900).max(2200).nullable().optional(),
  })).max(500) }).parse(await c.req.json());
  const generation = resolveGenerationTracks(c.req.param("id"), body.resolutions);
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(generation);
});

radioRoutes.get("/radio/generations/:id/revisions", (c) => {
  if (!presentGeneration(c.req.param("id"))) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json({ revisions: listGenerationRevisions(c.req.param("id")) });
});

radioRoutes.post("/radio/generations/:id/revisions/:revisionId/revert", async (c) => {
  const generation = revertGenerationRevision(c.req.param("id"), c.req.param("revisionId"));
  if (!generation) throw new AppError("RADIO_REVISION_NOT_FOUND", "Radio generation revision not found", 404);
  const normalized = syncRadioGenerationLengthToTracks(generation.id);
  if (!normalized) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found after revision restore", 404);
  return c.json(await finalizeRadioGeneration(normalized.id, { resequence: false }));
});

radioRoutes.post("/radio/generations/:id/reorder", async (c) => {
  const body = z.object({ trackIds: z.array(z.string().min(1)).min(1).max(500) }).parse(await c.req.json());
  const generation = reorderGenerationTracks(c.req.param("id"), body.trackIds);
  if (!generation) throw new AppError("RADIO_REORDER_INVALID", "Track order does not match this generation", 400);
  return c.json(generation);
});

radioRoutes.post("/radio/generations/:id/tracks", async (c) => {
  const body = z.object({
    position: z.number().int().min(0).max(500),
    artist: z.string().min(1).max(300),
    title: z.string().min(1).max(500),
    album: z.string().max(500).nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    spotifyId: z.string().max(128).nullable().optional(),
    navidromeId: z.string().max(128).nullable().optional(),
    isrc: z.string().max(32).nullable().optional(),
  }).parse(await c.req.json());
  const generation = insertManualGenerationTrack(c.req.param("id"), body);
  if (!generation) throw new AppError("RADIO_GENERATION_NOT_FOUND", "Radio generation not found", 404);
  return c.json(await finalizeRadioGeneration(generation.id, { resequence: false }), 201);
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
  if (input.scope === "station" && !input.stationId) {
    throw new AppError("VALIDATION_ERROR", "stationId is required for station feedback", 400);
  }
  return c.json({ feedback: recordRadioFeedback(input) }, 201);
});
