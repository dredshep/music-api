import { Hono } from "hono";

export const openapiManagerRadioRoute = new Hono();

const idParameter = [{ name: "id", in: "path", required: true, schema: { type: "string" } }] as const;
const trackParameters = [
  ...idParameter,
  { name: "trackId", in: "path", required: true, schema: { type: "string" } },
] as const;

const managerRadioSpec = {
  openapi: "3.1.0",
  info: {
    title: "Music Manager Radio API",
    version: "1.0.0",
    description: "Internal workstation API for editing finite saved Radio generations, importing external playlists, and managing local audio analysis. Not intended as the compact agent surface.",
  },
  servers: [{ url: "https://music-api.besto.me" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  paths: {
    "/manager/v1/radio/defaults": {
      get: { operationId: "getManagerRadioDefaults", summary: "Get Radio generation defaults", responses: { "200": { description: "Default Radio settings" } } },
    },
    "/manager/v1/radio/stations": {
      get: { operationId: "listManagerRadioStations", summary: "List saved Radio stations", responses: { "200": { description: "Saved stations" } } },
      post: { operationId: "createManagerRadioStation", summary: "Create a Radio station and optional first generation", responses: { "201": { description: "Created station and generation" } } },
    },
    "/manager/v1/radio/stations/{id}": {
      get: { operationId: "getManagerRadioStation", summary: "Get a Radio station", parameters: idParameter, responses: { "200": { description: "Station recipe and generation history" } } },
      patch: { operationId: "updateManagerRadioStation", summary: "Update a Radio station recipe", parameters: idParameter, responses: { "200": { description: "Updated station" } } },
      delete: { operationId: "deleteManagerRadioStation", summary: "Delete a Radio station", parameters: idParameter, responses: { "200": { description: "Station deleted" } } },
    },
    "/manager/v1/radio/stations/{id}/generate": {
      post: { operationId: "generateManagerRadioVersion", summary: "Generate another finite saved version", parameters: idParameter, responses: { "201": { description: "New generation" } } },
    },
    "/manager/v1/radio/generations/{id}": {
      get: { operationId: "getManagerRadioGeneration", summary: "Get an exact saved Radio generation", parameters: idParameter, responses: { "200": { description: "Generation with exact track order" } } },
    },
    "/manager/v1/radio/generations/{id}/clone": {
      post: { operationId: "cloneManagerRadioGeneration", summary: "Clone a generation as another saved version", parameters: idParameter, responses: { "201": { description: "Cloned generation" } } },
    },
    "/manager/v1/radio/generations/{id}/regenerate-tail": {
      post: { operationId: "regenerateManagerRadioTail", summary: "Regenerate a generation tail while preserving its prefix and pins", parameters: idParameter, responses: { "200": { description: "Updated generation" } } },
    },
    "/manager/v1/radio/generations/{id}/resolve": {
      post: { operationId: "resolveManagerRadioTracks", summary: "Attach external playback identifiers to generation tracks", parameters: idParameter, responses: { "200": { description: "Resolved generation" } } },
    },
    "/manager/v1/radio/generations/{id}/revisions": {
      get: { operationId: "listManagerRadioRevisions", summary: "List generation edit snapshots", parameters: idParameter, responses: { "200": { description: "Revision list" } } },
    },
    "/manager/v1/radio/generations/{id}/revisions/{revisionId}/revert": {
      post: {
        operationId: "revertManagerRadioRevision",
        summary: "Restore a generation from a saved revision",
        parameters: [...idParameter, { name: "revisionId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Restored generation" } },
      },
    },
    "/manager/v1/radio/generations/{id}/reorder": {
      post: { operationId: "reorderManagerRadioTracks", summary: "Replace the exact generation track order", parameters: idParameter, responses: { "200": { description: "Reordered generation" } } },
    },
    "/manager/v1/radio/generations/{id}/tracks": {
      post: { operationId: "insertManagerRadioTrack", summary: "Insert a manual track into a generation", parameters: idParameter, responses: { "201": { description: "Updated generation" } } },
    },
    "/manager/v1/radio/generations/{id}/tracks/{trackId}/pin": {
      post: { operationId: "pinManagerRadioTrack", summary: "Pin or unpin a generation track", parameters: trackParameters, responses: { "200": { description: "Updated generation" } } },
    },
    "/manager/v1/radio/generations/{id}/tracks/{trackId}": {
      delete: { operationId: "removeManagerRadioTrack", summary: "Remove a generation track", parameters: trackParameters, responses: { "200": { description: "Updated generation" } } },
    },
    "/manager/v1/radio/generations/{id}/import-external": {
      post: { operationId: "importManagerRadioPlaylist", summary: "Explicitly replace a generation from an external playlist", parameters: idParameter, responses: { "200": { description: "Imported generation with local playback re-resolution" } } },
    },
    "/manager/v1/radio/generations/{id}/analyze": {
      post: { operationId: "analyzeManagerRadioGeneration", summary: "Queue local audio analysis for playable local tracks", parameters: idParameter, responses: { "202": { description: "Analysis jobs queued" } } },
    },
    "/manager/v1/radio/audio-analysis/status": {
      get: { operationId: "getManagerRadioAnalysisStatus", summary: "Get the local audio-analysis queue status", responses: { "200": { description: "Analysis queue status" } } },
    },
    "/manager/v1/radio/feedback": {
      post: { operationId: "giveManagerRadioFeedback", summary: "Record explicit station or global Radio feedback", responses: { "201": { description: "Feedback persisted" } } },
    },
  },
} as const;

openapiManagerRadioRoute.get("/openapi-manager-radio.json", (c) => c.json(managerRadioSpec));

export function getManagerRadioOpenApiSpec() { return managerRadioSpec; }
