import { Hono } from "hono";

export const openapiManagerRoute = new Hono();

const managerSpec = {
  openapi: "3.1.0",
  info: {
    title: "Music Manager API",
    version: "1.0.0",
    description:
      "Internal API surface for the Music Manager web frontend. Provides lower-level access to Soulseek searches, transfers, peer analytics, messaging history, and download management. Not intended for agent/ChatGPT consumption.",
  },
  servers: [{ url: "https://music-api.besto.me" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Manager API key (MANAGER_API_KEY) or main API key, passed as Bearer token.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              retryable: { type: "boolean" },
            },
            required: ["code", "message", "retryable"],
          },
        },
      },
    },
  },
  paths: {
    "/manager/v1/soulseek/searches": {
      get: {
        operationId: "listSlskdSearches",
        summary: "List all slskd searches",
        description:
          "Returns the current slskd search registry, including historical searches.",
        responses: {
          "200": {
            description: "List of slskd searches",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    searches: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          searchText: { type: "string" },
                          state: { type: "string" },
                          fileCount: { type: "integer" },
                          responseCount: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/manager/v1/soulseek/searches/{id}": {
      get: {
        operationId: "getSlskdSearch",
        summary: "Get a single slskd search",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "slskd search state" },
        },
      },
    },
    "/manager/v1/soulseek/searches/{id}/responses": {
      get: {
        operationId: "getSlskdSearchResponses",
        summary: "Get responses for a slskd search",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Search responses with peer results" },
        },
      },
    },
    "/manager/v1/soulseek/searches/{id}/refresh": {
      post: {
        operationId: "refreshSlskdSearch",
        summary: "Refresh an existing search's responses",
        description:
          "Re-polls slskd for current responses without creating new searches.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Refreshed search results" },
        },
      },
    },
    "/manager/v1/soulseek/searches/{id}/research": {
      post: {
        operationId: "researchSlskdSearch",
        summary: "Create fresh slskd searches for an existing semantic search",
        description:
          "Deliberately creates new slskd searches. This is the explicit re-search action.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "New search created with fresh variants" },
        },
      },
    },
    "/manager/v1/soulseek/transfers/downloads": {
      get: {
        operationId: "listLiveDownloads",
        summary: "List live slskd download transfers",
        responses: {
          "200": { description: "Active download transfers" },
        },
      },
    },
    "/manager/v1/soulseek/transfers/uploads": {
      get: {
        operationId: "listLiveUploads",
        summary: "List live slskd upload transfers",
        responses: {
          "200": { description: "Active upload transfers" },
        },
      },
    },
    "/manager/v1/soulseek/transfers/cancel": {
      post: {
        operationId: "cancelSlskdTransfer",
        summary: "Cancel an in-progress slskd transfer",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "id", "direction"],
                properties: {
                  username: { type: "string" },
                  id: { type: "string" },
                  direction: {
                    type: "string",
                    enum: ["downloads", "uploads"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Transfer cancelled" },
        },
      },
    },
    "/manager/v1/soulseek/users/{username}/info": {
      get: {
        operationId: "getSlskdUserInfo",
        summary: "Get Soulseek user info, status, and browse data",
        parameters: [
          {
            name: "username",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "User info, status, and shared files" },
        },
      },
    },
    "/manager/v1/soulseek/history": {
      get: {
        operationId: "getTransferHistory",
        summary: "Get transfer history from slskd's transfers.db",
        parameters: [
          {
            name: "direction",
            in: "query",
            schema: { type: "string", enum: ["Download", "Upload"] },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 2000 },
          },
          {
            name: "username",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "search",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Transfer history entries" },
        },
      },
    },
    "/manager/v1/soulseek/stats": {
      get: {
        operationId: "getSoulseekStats",
        summary: "Get aggregate Soulseek transfer statistics",
        responses: {
          "200": { description: "Transfer overview and stats" },
        },
      },
    },
    "/manager/v1/soulseek/stats/breakdown/{direction}": {
      get: {
        operationId: "getStateBreakdown",
        summary: "Get transfer state breakdown by direction",
        parameters: [
          {
            name: "direction",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["Upload", "Download"] },
          },
        ],
        responses: {
          "200": { description: "State breakdown counts" },
        },
      },
    },
    "/manager/v1/soulseek/peers": {
      get: {
        operationId: "listTopPeers",
        summary: "List top Soulseek peers by upload volume",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 500 },
          },
        ],
        responses: {
          "200": { description: "Peer summaries" },
        },
      },
    },
    "/manager/v1/soulseek/peers/{username}/analytics": {
      get: {
        operationId: "getPeerAnalytics",
        summary: "Get detailed analytics for a Soulseek peer",
        parameters: [
          {
            name: "username",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Peer analytics and transfer history" },
        },
      },
    },
    "/manager/v1/soulseek/messages": {
      get: {
        operationId: "listRecentMessages",
        summary: "List recent Soulseek private messages",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 1000 },
          },
        ],
        responses: {
          "200": { description: "Recent private messages" },
        },
      },
    },
    "/manager/v1/soulseek/messages/{username}": {
      get: {
        operationId: "getMessagesForUser",
        summary: "Get Soulseek messages for a specific user",
        parameters: [
          {
            name: "username",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Messages for the specified user" },
        },
      },
    },
  },
} as const;

openapiManagerRoute.get("/openapi-manager.json", (c) => {
  return c.json(managerSpec);
});

export function getManagerOpenApiSpec() {
  return managerSpec;
}
