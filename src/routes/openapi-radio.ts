import { Hono } from "hono";

export const openapiRadioRoute = new Hono();

const seed = {
  type: "object",
  required: ["type", "label"],
  properties: {
    type: { type: "string", enum: ["track", "artist", "album", "genre", "playlist", "liked", "library", "collection"] },
    entityId: { type: ["string", "null"] },
    artist: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    label: { type: "string" },
    weight: { type: "number", minimum: 0.01 },
    position: { type: ["number", "null"] },
  },
} as const;

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Radio API",
    version: "1.0.0",
    description: "Semantic API for finite, saved music radio stations and generations. Radio generations never silently mutate or auto-extend.",
  },
  servers: [{ url: "https://music-api.besto.me" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/v1/radio/stations": {
      get: {
        operationId: "listRadioStations",
        summary: "List saved radio stations",
        responses: { "200": { description: "Saved stations with their dated generations" } },
      },
      post: {
        operationId: "createRadio",
        summary: "Create a finite saved radio",
        description: "Create a station from one or more weighted seeds. Set type=gradient for an A→B or multipoint musical trajectory. A finite generation is created by default.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["name", "seeds"],
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["standard", "gradient"] },
              seeds: { type: "array", minItems: 1, items: seed },
              settings: { type: "object", additionalProperties: true },
              generate: { type: "boolean", default: true },
            },
          } } },
        },
        responses: { "201": { description: "Station and optional first generation" } },
      },
    },
    "/v1/radio/stations/{id}": {
      get: {
        operationId: "getRadioStation",
        summary: "Get a radio station recipe and generation history",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Station recipe, seeds, settings and dated generations" } },
      },
    },
    "/v1/radio/stations/{id}/generate": {
      post: {
        operationId: "generateRadioVersion",
        summary: "Generate another saved version",
        description: "Generate a new finite child playlist without replacing any previous generation.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { length: { type: "integer", minimum: 1, maximum: 200 } } } } } },
        responses: { "201": { description: "New saved generation" } },
      },
    },
    "/v1/radio/generations/{id}": {
      get: {
        operationId: "getRadioGeneration",
        summary: "Get an exact saved radio playlist",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Exact persisted track sequence and availability" } },
      },
    },
    "/v1/radio/feedback": {
      post: {
        operationId: "giveRadioFeedback",
        summary: "Record explicit radio feedback",
        description: "Record more-like, less-like, station ban, or explicit global rank-down/ban. Ordinary playback skips do not train Radio.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object",
          required: ["scope", "entityType", "entityKey", "action"],
          properties: {
            scope: { type: "string", enum: ["station", "global"] },
            stationId: { type: ["string", "null"] },
            entityType: { type: "string", enum: ["track", "artist"] },
            entityKey: { type: "string" },
            action: { type: "string", enum: ["more_like", "less_like", "ban_station", "rank_down_global", "ban_track_global", "ban_artist_global"] },
          },
        } } } },
        responses: { "201": { description: "Feedback persisted" } },
      },
    },
  },
} as const;

openapiRadioRoute.get("/openapi-radio.json", (c) => c.json(spec));

export function getRadioOpenApiSpec() { return spec; }
