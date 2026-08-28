import { Hono } from "hono";

export const openapiRadioRoute = new Hono();

const seedCommon = {
  entityId: { type: ["string", "null"] },
  label: { type: "string" },
  weight: { type: "number", minimum: 0.01 },
  position: { type: ["number", "null"], minimum: 0, maximum: 1, description: "User waypoint position normalized from 0 (start) to 1 (end). Generated track coordinates are discovered from the recording route and are not playlist-index percentages." },
  metadata: { type: ["object", "null"], additionalProperties: true, description: "Optional stable identity/provider metadata. Exact track seeds may include recordingMbid/musicbrainzId/mbid so the requested recording identity survives route planning." },
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
      description: "Gradient route strategy. geodesic finds a compact bounded path through recording similarity; scenic spends a wider search/densification budget; blend is the legacy endpoint interpolation baseline.",
      default: "geodesic",
    },
    gradientRouteStrength: {
      type: "number",
      minimum: 0,
      maximum: 8,
      description: "Legacy/compatibility setting retained in station recipes. Recording-path geodesic/scenic generations use the discovered path itself rather than mixing it into generic candidate ranking.",
      default: 2.4,
    },
    gradientRouteWidth: {
      type: "number",
      minimum: 0.05,
      maximum: 0.6,
      description: "Legacy/compatibility route-width setting retained in station recipes.",
      default: 0.22,
    },
  },
} as const;

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Radio API",
    version: "1.3.0",
    description: "Semantic API for finite saved Radio plus coherent bounded live continuation. Gradient geodesic/scenic discovers recording-level A→B paths, assigns only authoritative musical-route coordinates, and labels ordinary Radio fallback explicitly when no valid path exists. Saved generations never silently mutate or auto-extend.",
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
        description: "Create a station from self-sufficient track, artist, album, genre, or local-library seeds. For type=gradient, geodesic/scenic searches recursively through recording-level neighbors between waypoints rather than mixing endpoint recommendation lists. Exact track metadata may carry a recording MBID.",
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
        description: "Generate a new finite child playlist without replacing previous generations. Successful geodesic/scenic Gradient generations persist the actual recording path, graph edges, cache/search diagnostics, bottleneck and familiarity data.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { length: { type: "integer", minimum: 1, maximum: 200 } } } } } },
        responses: { "201": { description: "New saved generation" } },
      },
    },
    "/v1/radio/stations/{id}/live-batch": {
      post: {
        operationId: "continueLiveRadio",
        summary: "Generate or continue a bounded live route",
        description: "A successful recording-level Gradient first batch returns route_state containing the bounded finalized route. Return that state unchanged as routeState on later refills so every batch consumes the same A→B path. The route terminates at B with route_completed=true; it does not silently wrap to A. routeCursor remains for legacy/partial/fallback continuation.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 4, maximum: 30 },
            excludeKeys: { type: "array", maxItems: 5000, items: { type: "string" } },
            routeCursor: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Legacy/partial/fallback route cursor. Successful recording-path sessions should return the previous route_state instead." },
            routeState: { type: ["object", "null"], additionalProperties: true, description: "Opaque bounded recording-path state returned as route_state by the prior batch." },
          },
        } } } },
        responses: { "200": { description: "Ephemeral continuation including route_state and route_completed for coherent recording-path sessions" } },
      },
    },
    "/v1/radio/generations/{id}": {
      get: {
        operationId: "getRadioGeneration",
        summary: "Get an exact saved radio playlist",
        description: "Gradient diagnostics expose the discovered recording route, providers/cache/search metrics and route state. trajectory_position is a musical coordinate only when metadata marks trajectoryCoordinateKind=musical_route; fallback/unsupported tracks remain unpositioned.",
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
