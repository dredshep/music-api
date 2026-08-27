import { Hono } from "hono";

export const openapiRadioRoute = new Hono();

const seedCommon = {
  entityId: { type: ["string", "null"] },
  label: { type: "string" },
  weight: { type: "number", minimum: 0.01 },
  position: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Gradient waypoint position normalized from 0 (start) to 1 (end)." },
} as const;

const seed = {
  oneOf: [
    {
      type: "object",
      required: ["type", "label", "artist", "title"],
      properties: {
        ...seedCommon,
        type: { const: "track" },
        artist: { type: "string" },
        title: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "label", "artist"],
      properties: {
        ...seedCommon,
        type: { const: "artist" },
        artist: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "label", "artist", "title"],
      properties: {
        ...seedCommon,
        type: { const: "album" },
        artist: { type: "string" },
        title: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "label"],
      properties: {
        ...seedCommon,
        type: { const: "genre" },
      },
    },
    {
      type: "object",
      required: ["type", "label"],
      properties: {
        ...seedCommon,
        type: { const: "library" },
      },
    },
  ],
} as const;

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Radio API",
    version: "1.0.0",
    description: "Semantic API for finite saved Radio plus explicit bounded live continuation. Saved generations never silently mutate or auto-extend.",
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
        description: "Create a station from self-sufficient track, artist, album, genre, or local-library seeds. Set type=gradient for an A→B or multipoint musical trajectory. A finite generation is created by default.",
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
    "/v1/radio/stations/{id}/live-batch": {
      post: {
        operationId: "continueLiveRadio",
        summary: "Generate a bounded live continuation",
        description: "Return an ephemeral continuation batch without adding it to saved-generation history. The caller explicitly requests each bounded batch and may exclude tracks already buffered.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 4, maximum: 30 },
            excludeKeys: { type: "array", maxItems: 5000, items: { type: "string" } },
          },
        } } } },
        responses: { "200": { description: "Ephemeral continuation batch" } },
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
