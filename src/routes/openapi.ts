import { Hono } from "hono";

export const openapiRoute = new Hono();

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Automation API",
    version: "1.0.0",
    description:
      "A semantic music library management API. Searches Soulseek for release candidates, checks Navidrome for owned music, compares catalogs via MusicBrainz, and manages logical download jobs. Designed for LLM tool use.",
  },
  servers: [{ url: "https://music-api.besto.me" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "API key passed as a Bearer token in the Authorization header.",
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
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Health check",
        description: "Returns ok if the service is running. No authentication required. Does not probe upstream services.",
        security: [],
        responses: {
          "200": {
            description: "Service is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", enum: ["ok"] } },
                },
              },
            },
          },
        },
      },
    },
    "/v1/status": {
      get: {
        operationId: "getMusicSystemStatus",
        summary: "Get system status including upstream service availability",
        description:
          "Probes slskd, Navidrome, and MusicBrainz connectivity. Returns overall status (ok, degraded, unavailable) and per-service availability. Use this to check whether the music system is healthy before issuing commands.",
        responses: {
          "200": {
            description: "System status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok", "degraded", "unavailable"] },
                    services: {
                      type: "object",
                      properties: {
                        slskd: {
                          type: "object",
                          properties: {
                            available: { type: "boolean" },
                            error: { type: "string" },
                          },
                        },
                        navidrome: {
                          type: "object",
                          properties: {
                            available: { type: "boolean" },
                            error: { type: "string" },
                          },
                        },
                        musicbrainz: {
                          type: "object",
                          properties: {
                            available: { type: "boolean" },
                            error: { type: "string" },
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
    },
    "/v1/library/search": {
      post: {
        operationId: "searchLibrary",
        summary: "Check if music is already owned in the library",
        description:
          "Searches Navidrome for an artist/title combination and returns ownership confidence. Use this to determine whether a release needs to be downloaded. Returns matched albums with confidence scores and match reasons.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  artist: { type: "string", description: "Artist name to search for" },
                  title: { type: "string", description: "Album/release title (optional)" },
                  release_type: {
                    type: "string",
                    enum: ["album", "ep", "single", "track", "any"],
                    default: "any",
                  },
                },
                required: ["artist"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Ownership result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    owned: { type: "boolean" },
                    confidence: { type: "number" },
                    matches: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          artist: { type: "string" },
                          title: { type: "string" },
                          year: { type: "integer" },
                          track_count: { type: "integer" },
                          navidrome_id: { type: "string" },
                          confidence: { type: "number" },
                          match_reasons: { type: "array", items: { type: "string" } },
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
    "/v1/library/overview": {
      get: {
        operationId: "getLibraryOverview",
        summary: "Summarize the owned music library",
        description:
          "Library totals plus top artists. by=album_count (default) ranks by collection size; by=play_count ranks by summed album listens. Prefer over searchLibrary for broad taste/overview queries.",
        parameters: [
          {
            name: "top",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 200 },
            description: "How many top artists to include",
          },
          {
            name: "by",
            in: "query",
            schema: {
              type: "string",
              enum: ["album_count", "play_count"],
              default: "album_count",
            },
            description:
              "Ranking metric. play_count sums album playCounts for artists that have listening history.",
          },
        ],
        responses: {
          "200": {
            description: "Library overview",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "object",
                      properties: {
                        artist_count: { type: "integer" },
                        album_count: { type: "integer" },
                      },
                    },
                    top_artists: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          album_count: { type: "integer" },
                          navidrome_id: { type: "string" },
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
    "/v1/library/artists": {
      get: {
        operationId: "listLibraryArtists",
        summary: "List artists in the owned library",
        description:
          "Paginated list of artists from Navidrome. sort=album_count (default), name, or play_count. play_count ranks by summed album listens. Optional q filters by artist name substring. limit default 100 max 500.",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 100, maximum: 500 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
          {
            name: "sort",
            in: "query",
            schema: {
              type: "string",
              enum: ["album_count", "name", "play_count"],
              default: "album_count",
            },
          },
          {
            name: "q",
            in: "query",
            schema: { type: "string" },
            description: "Optional case-insensitive artist name filter",
          },
        ],
        responses: {
          "200": {
            description: "Artist page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    offset: { type: "integer" },
                    limit: { type: "integer" },
                    sort: { type: "string" },
                    artists: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          album_count: { type: "integer" },
                          navidrome_id: { type: "string" },
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
    "/v1/library/scan": {
      get: {
        operationId: "getLibraryScanStatus",
        summary: "Check library scan status",
        description: "Returns whether Navidrome is currently scanning the music library.",
        responses: {
          "200": {
            description: "Scan status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scanning: { type: "boolean" },
                    last_scan: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "startLibraryScan",
        summary: "Trigger a Navidrome library scan",
        description:
          "Starts a Navidrome library scan. Use after downloads complete and files are moved into the library folder. Set full=true only when needed; incremental scans are usually sufficient.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  full: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Scan started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["started"] },
                    full: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/catalog/missing": {
      post: {
        operationId: "getMissingCatalog",
        summary: "Find releases missing from the library for an artist",
        description:
          "Local-first catalog comparison. Uses cached MusicBrainz release groups when fresh; refreshes from MB only when stale (>30d) or force_refresh=true.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  artist: { type: "string", description: "Artist name" },
                  musicbrainz_id: {
                    type: "string",
                    description: "Optional MusicBrainz artist ID to skip resolution",
                  },
                  release_types: {
                    type: "array",
                    items: { type: "string" },
                    default: ["Album", "EP", "Single"],
                  },
                  include_compilations: { type: "boolean", default: false },
                  force_refresh: {
                    type: "boolean",
                    default: false,
                    description: "Force re-fetch from MusicBrainz even if cache is fresh",
                  },
                },
                required: ["artist"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Catalog comparison result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    artist: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        musicbrainz_id: { type: "string" },
                      },
                    },
                    catalog_source: { type: "string", enum: ["local", "musicbrainz"] },
                    catalog_checked_at: { type: "string", format: "date-time" },
                    summary: {
                      type: "object",
                      properties: {
                        catalog_releases: { type: "integer" },
                        owned: { type: "integer" },
                        missing: { type: "integer" },
                        uncertain: { type: "integer" },
                      },
                    },
                    missing: { type: "array", items: { type: "object" } },
                    uncertain: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/catalog/stats": {
      get: {
        operationId: "getCatalogStats",
        summary: "Get catalog cache freshness statistics",
        description:
          "Returns how many artists have fresh/stale/unknown catalog data locally. Useful for knowing whether getMissingCatalog will hit MusicBrainz or answer from cache.",
        responses: {
          "200": {
            description: "Catalog freshness stats",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    catalog_freshness: {
                      type: "object",
                      properties: {
                        total_artists: { type: "integer" },
                        total_release_groups: { type: "integer" },
                        fresh: { type: "integer" },
                        stale: { type: "integer" },
                        unknown: { type: "integer" },
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
    "/v1/catalog/library-missing": {
      post: {
        operationId: "getLibraryMissingCatalog",
        summary: "Bulk missing releases across all cached artists",
        description:
          "Local-only. Compares every cached MusicBrainz catalog against the full Navidrome library. Ranked by missing count. Populate cache via getMissingCatalog first; check freshness with getCatalogStats.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  release_types: {
                    type: "array",
                    items: { type: "string" },
                    default: ["Album"],
                  },
                  include_compilations: { type: "boolean", default: false },
                  min_missing: {
                    type: "integer",
                    default: 1,
                    description: "Only include artists with at least this many missing releases",
                  },
                  limit_artists: {
                    type: "integer",
                    default: 50,
                    maximum: 500,
                    description: "Max artists to return, sorted by missing count desc",
                  },
                  include_releases: {
                    type: "boolean",
                    default: true,
                    description: "If false, return per-artist summaries only",
                  },
                  only_checked: {
                    type: "boolean",
                    default: true,
                    description: "Skip artists that have never been fetched from MusicBrainz",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Bulk missing catalog comparison",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    catalog_source: { type: "string", enum: ["local"] },
                    catalog_freshness: {
                      type: "object",
                      properties: {
                        total_artists: { type: "integer" },
                        total_release_groups: { type: "integer" },
                        fresh: { type: "integer" },
                        stale: { type: "integer" },
                        unknown: { type: "integer" },
                      },
                    },
                    artists_compared: { type: "integer" },
                    summary: {
                      type: "object",
                      properties: {
                        artists_with_missing: { type: "integer" },
                        total_catalog_releases: { type: "integer" },
                        total_owned: { type: "integer" },
                        total_missing: { type: "integer" },
                        total_uncertain: { type: "integer" },
                      },
                    },
                    artists: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          musicbrainz_id: { type: "string" },
                          catalog_checked_at: { type: "string", format: "date-time" },
                          summary: { type: "object" },
                          missing: { type: "array", items: { type: "object" } },
                          uncertain: { type: "array", items: { type: "object" } },
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
    "/v1/api-suggestions": {
      post: {
        operationId: "createApiSuggestion",
        summary: "File a bug, feature request, or API ergonomics issue",
        description:
          "Agent feedback intake. Use dedupe_key to bump occurrences on repeat sightings. Attach request_id from X-Request-Id to link server logs. context is arbitrary JSON evidence.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["type", "title"],
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "bug",
                      "feature",
                      "improvement",
                      "api_design",
                      "data_quality",
                      "performance",
                    ],
                  },
                  title: { type: "string" },
                  summary: { type: "string" },
                  severity: {
                    type: "string",
                    enum: ["low", "medium", "high", "critical"],
                    default: "medium",
                  },
                  component: { type: "string" },
                  observed_behavior: { type: "object", additionalProperties: true },
                  expected_behavior: { type: "string" },
                  suggested_fix: { type: "string" },
                  context: { type: "object", additionalProperties: true },
                  dedupe_key: { type: "string" },
                  request_id: {
                    type: "string",
                    description: "Optional; defaults to this request's X-Request-Id",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Created" },
          "200": { description: "Deduped existing open issue; occurrences incremented" },
        },
      },
      get: {
        operationId: "listApiSuggestions",
        summary: "List API suggestions / issues",
        description:
          "Filter with status, type, and/or component query params. Defaults to newest-updated first.",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["open", "planned", "in_progress", "resolved", "wont_fix"],
            },
          },
          {
            name: "type",
            in: "query",
            schema: {
              type: "string",
              enum: [
                "bug",
                "feature",
                "improvement",
                "api_design",
                "data_quality",
                "performance",
              ],
            },
          },
          {
            name: "component",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 200 },
          },
        ],
        responses: {
          "200": { description: "Suggestion list" },
        },
      },
    },
    "/v1/api-suggestions/{id}": {
      get: {
        operationId: "getApiSuggestion",
        summary: "Get one API suggestion by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Suggestion" },
          "404": { description: "Not found" },
        },
      },
      patch: {
        operationId: "updateApiSuggestion",
        summary: "Update or close an API suggestion",
        description:
          "Set status to resolved/wont_fix/planned/in_progress, or edit severity/title/summary/context.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    enum: ["open", "planned", "in_progress", "resolved", "wont_fix"],
                  },
                  severity: {
                    type: "string",
                    enum: ["low", "medium", "high", "critical"],
                  },
                  title: { type: "string" },
                  summary: { type: "string" },
                  component: { type: "string" },
                  expected_behavior: { type: "string" },
                  suggested_fix: { type: "string" },
                  observed_behavior: { type: "object", additionalProperties: true },
                  context: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated suggestion" },
          "404": { description: "Not found" },
        },
      },
    },
    "/v1/search": {
      post: {
        operationId: "searchMusic",
        summary: "Search Soulseek for a release and return ranked candidates",
        description:
          "Searches Soulseek for the specified artist/title, groups results by peer+directory, enriches directories, scores candidates on format, completeness, LRC coverage, and peer availability, then returns the top candidates. Each candidate has an opaque ID used for downloading. Never invent candidate IDs.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  artist: { type: "string" },
                  title: { type: "string" },
                  release_type: {
                    type: "string",
                    enum: ["album", "ep", "single", "track", "any"],
                    default: "album",
                  },
                  preferred_formats: {
                    type: "array",
                    items: { type: "string" },
                    default: ["FLAC", "MP3"],
                  },
                  prefer_lrc: { type: "boolean", default: true },
                  max_candidates: { type: "integer", default: 10, maximum: 20 },
                },
                required: ["artist", "title"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Search results with ranked candidates",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    search_id: { type: "string" },
                    query: { type: "object" },
                    candidates: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "Opaque candidate ID for use with enqueueCandidate" },
                          release: { type: "string" },
                          peer: { type: "string" },
                          format: { type: "string" },
                          track_count: { type: "integer" },
                          lrc_count: { type: "integer" },
                          lrc_coverage: { type: "number" },
                          has_cover: { type: "boolean" },
                          size_mb: { type: "number" },
                          upload_speed_mbps: { type: "number" },
                          free_upload_slots: { type: "boolean" },
                          queue_length: { type: "integer" },
                          score: { type: "number" },
                          flags: { type: "array", items: { type: "string" } },
                          reason: { type: "string" },
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
    "/v1/searches/{search_id}": {
      get: {
        operationId: "refreshMusicSearch",
        summary: "Refresh a previous Soulseek search for updated results",
        description:
          "Re-polls the associated slskd searches for newly arrived peer responses, re-ranks candidates, and returns the updated list. Use when initial results were weak and you want to check if better peers have responded. Expired searches return HTTP 410.",
        parameters: [
          {
            name: "search_id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "The search_id from a previous searchMusic or previewAcquire call",
          },
        ],
        responses: {
          "200": { description: "Updated search results" },
          "410": { description: "Search expired" },
        },
      },
    },
    "/v1/acquire/preview": {
      post: {
        operationId: "previewAcquire",
        summary: "Check ownership then search if not owned",
        description:
          "Convenience endpoint that first checks Navidrome for ownership. If confidently owned, returns the library match. Otherwise, performs a Soulseek search and returns candidates. No download occurs. This is typically the first call for 'find me this album'.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  artist: { type: "string" },
                  title: { type: "string" },
                  release_type: {
                    type: "string",
                    enum: ["album", "ep", "single", "track", "any"],
                    default: "album",
                  },
                },
                required: ["artist", "title"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Ownership status and candidates if not owned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["owned", "not_owned"] },
                    library_match: { type: "object", nullable: true },
                    search_id: { type: "string" },
                    candidates: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/downloads": {
      post: {
        operationId: "enqueueCandidate",
        summary: "Download a previously discovered music candidate",
        description:
          "Enqueues the complete release represented by a candidate ID returned by searchMusic, refreshMusicSearch, or previewAcquire. Never invent candidate IDs. Includes audio files, matching LRC lyrics, cover art, and useful sidecars. Idempotent: re-sending the same candidate returns the existing job.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  candidate_id: {
                    type: "string",
                    description: "Opaque candidate ID from a search result",
                  },
                },
                required: ["candidate_id"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Download job created" },
          "200": { description: "Download already queued (idempotent)" },
          "410": { description: "Candidate expired" },
        },
      },
      get: {
        operationId: "getTransfers",
        summary: "List download jobs",
        description:
          "Returns download jobs filtered by status. Default shows active (queued + downloading + retrying). Use to check what is currently downloading or stuck.",
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["active", "queued", "downloading", "failed", "completed", "all"],
              default: "active",
            },
          },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        ],
        responses: {
          "200": { description: "List of download jobs" },
        },
      },
    },
    "/v1/downloads/{job_id}": {
      get: {
        operationId: "getTransfer",
        summary: "Get detailed status of a single download job",
        description:
          "Returns the full status of one logical release download including per-file progress and failure details.",
        parameters: [
          {
            name: "job_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Download job details" },
          "404": { description: "Job not found" },
        },
      },
    },
    "/v1/downloads/{job_id}/control": {
      post: {
        operationId: "controlTransfer",
        summary: "Control a download job (cancel, retry, or try alternate peer)",
        description:
          "Performs an action on a download job. 'retry' re-enqueues only failed files from the same peer. 'retry_alternate' searches for a compatible alternative peer and enqueues only the missing/failed files. 'cancel' stops all active transfers for the job.",
        parameters: [
          {
            name: "job_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["cancel", "retry", "retry_alternate"],
                    description: "cancel: stop all transfers. retry: retry failed files from same peer. retry_alternate: find and use a different peer for failed files.",
                  },
                },
                required: ["action"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Control action result" },
          "404": { description: "Job not found" },
        },
      },
    },
    "/v1/recommendations/generate": {
      post: {
        operationId: "generateRecommendations",
        summary: "Generate fresh recommendations",
        description: "Runs the full recommendation pipeline: fetches seeds from Last.fm, generates candidates from similar artists / ListenBrainz / new releases, canonicalizes via MusicBrainz, filters owned, scores, and persists. Returns generation summary.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  limit: { type: "integer", minimum: 1, maximum: 200, description: "Max recommendations to select" },
                  sources: {
                    type: "array",
                    items: { type: "string", enum: ["lastfm_similar", "listenbrainz_cf", "musicbrainz_new_release"] },
                    description: "Which candidate sources to use. Defaults to all.",
                  },
                  include_uncertain: { type: "boolean", description: "Include uncertain ownership candidates" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Generation completed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    generation_id: { type: "string" },
                    status: { type: "string", enum: ["completed", "partial", "failed"] },
                    selected: { type: "integer" },
                    stats: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/recommendations": {
      get: {
        operationId: "getRecommendations",
        summary: "Get recommendation feed",
        description: "Returns scored recommendations with full provenance. Defaults to active, non-owned, non-suppressed items sorted by score descending.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "type", in: "query", schema: { type: "string", enum: ["artist", "release_group", "any"] } },
          { name: "reason", in: "query", schema: { type: "string", enum: ["similar_to_recent", "similar_to_favorite", "collaborative", "new_release", "wildcard"] } },
          { name: "min_score", in: "query", schema: { type: "number" } },
          { name: "include_owned", in: "query", schema: { type: "boolean", default: false } },
          { name: "include_uncertain", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": {
            description: "Recommendation feed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    recommendations: { type: "array", items: { $ref: "#/components/schemas/Recommendation" } },
                    count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/recommendations/{id}": {
      get: {
        operationId: "getRecommendation",
        summary: "Get recommendation detail",
        description: "Returns full recommendation detail with score breakdown, evidence provenance, and feedback history.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Recommendation detail" },
          "404": { description: "Recommendation not found" },
        },
      },
    },
    "/v1/recommendations/{id}/feedback": {
      post: {
        operationId: "submitRecommendationFeedback",
        summary: "Submit feedback on a recommendation",
        description: "Record explicit feedback. 'dislike' and 'already_know' suppress the recommendation from future feeds. 'love' and 'interested' are positive signals.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["feedback"],
                properties: {
                  feedback: { type: "string", enum: ["love", "interested", "meh", "dislike", "already_know"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Feedback recorded" },
          "404": { description: "Recommendation not found" },
        },
      },
    },
    "/v1/recommendations/generations": {
      get: {
        operationId: "getRecommendationGenerations",
        summary: "List generation runs",
        description: "Returns recent recommendation generation summaries with status, timing, and candidate counts.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["running", "completed", "partial", "failed"] } },
        ],
        responses: {
          "200": { description: "Generation list" },
        },
      },
    },
    "/v1/recommendations/generations/{id}": {
      get: {
        operationId: "getRecommendationGeneration",
        summary: "Get generation detail",
        description: "Returns full diagnostics for a generation run: seed count, source stats, errors, timing, and candidate breakdown.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Generation detail" },
          "404": { description: "Generation not found" },
        },
      },
    },
  },
};

// Add Recommendation schema to components
(spec.components.schemas as Record<string, unknown>)["Recommendation"] = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["artist", "release_group"] },
    artist: { type: "string" },
    artist_mbid: { type: "string" },
    release: { type: "string", nullable: true },
    release_group_mbid: { type: "string", nullable: true },
    score: { type: "number", minimum: 0, maximum: 1 },
    score_breakdown: {
      type: "object",
      properties: {
        external_similarity: { type: "number" },
        seed_affinity: { type: "number" },
        source_consensus: { type: "number" },
        recency: { type: "number" },
        novelty: { type: "number" },
        popularity: { type: "number" },
      },
    },
    primary_reason: { type: "string", enum: ["similar_to_recent", "similar_to_favorite", "collaborative", "new_release", "wildcard"] },
    ownership: {
      type: "object",
      properties: { state: { type: "string", enum: ["owned", "missing", "uncertain", "unknown"] } },
    },
    first_release_date: { type: "string", nullable: true },
    first_seen_at: { type: "string" },
    last_recommended_at: { type: "string", nullable: true },
    times_recommended: { type: "integer" },
    feedback: { type: "string", nullable: true, enum: ["love", "interested", "meh", "dislike", "already_know"] },
  },
};

openapiRoute.get("/openapi.json", (c) => {
  return c.json(spec);
});
