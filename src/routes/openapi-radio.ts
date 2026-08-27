import { Hono } from "hono";

export const openapiRadioRoute = new Hono();

const seedCommon = {
  entityId: { type: ["string", "null"] },
  label: { type: "string" },
  weight: { type: "number", minimum: 0.01 },
  position: { type: ["number", "null"], minimum: 0, maximum: 1, description: "User waypoint position normalized from 0 (start) to 1 (end). Generated track coordinates are discovered from the musical route and are not playlist-index percentages." },
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

const radioSettings = {
  type: "object",
  additionalProperties: true,
  properties: {
    gradientAlgorithm: {
      type: "string",
      enum: ["geodesic", "scenic", "blend"],
      description: "Gradient route strategy. geodesic finds a compact path through locally related musical regions; scenic explores a wider/longer path; blend is the legacy endpoint interpolation baseline.",
      default: "geodesic",
    },
    gradientRouteStrength: {
      type: "number",
      minimum: 0,
      maximum: 8,
      description: "How strongly generated tracks must follow the discovered musical route rather than generic Radio ranking.",
      default: 2.4,
    },
    gradientRouteWidth: {
      type: "number",
      minimum: 0.05,
      maximum: 0.6,
      description: "Allowed local width around each discovered route coordinate. Smaller values enforce a tighter path.",
      default: 0.22,
    },
  },
} as const;

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Radio API",
    version: "1.2.0",
    description: "Semantic API for finite saved Radio plus cursor-aware bounded live continuation. Gradient Radio can discover graph-based musical routes whose intermediate regions need no direct endpoint similarity. Saved generations never silently mutate or auto-extend.",
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
        description: "Create a station from self-sufficient track, artist, album, genre, or local-library seeds. For type=gradient, geodesic/scenic route discovery walks locally related musical regions between adjacent waypoints instead of merely mixing endpoint recommendation lists.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["name", "seeds"],
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["standard", "gradient"] },
              seeds: { type: "array", minItems: 1, items: seed },
              settings: radioSettings,
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
        description: "Generate a new finite child playlist without replacing any previous generation. Gradient stations reuse their selected route algorithm and persist route diagnostics with the generation.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { length: { type: "integer", minimum: 1, maximum: 200 } } } } } },
        responses: { "201": { description: "New saved generation" } },
      },
    },
    "/v1/radio/stations/{id}/live-batch": {
      post: {
        operationId: "continueLiveRadio",
        summary: "Generate a bounded live continuation",
        description: "Return an ephemeral continuation batch without adding it to saved-generation history. For Gradient stations pass each response next_cursor back as routeCursor so later batches continue forward through the musical route and wrap only after reaching its end.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 4, maximum: 30 },
            excludeKeys: { type: "array", maxItems: 5000, items: { type: "string" } },
            routeCursor: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Normalized musical-route continuation coordinate from the previous next_cursor. Use 0 or omit for the first batch." },
          },
        } } } },
        responses: { "200": { description: "Ephemeral continuation with route_cursor, next_cursor and route_wrapped for Gradient sessions" } },
      },
    },
    "/v1/radio/generations/{id}": {
      get: {
        operationId: "getRadioGeneration",
        summary: "Get an exact saved radio playlist",
        description: "Gradient generation diagnostics include the discovered route. Track trajectory_position is a musical route coordinate only for graph-routed generations; legacy blend tracks do not claim a musical coordinate.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Exact persisted track sequence, availability and route diagnostics" } },
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