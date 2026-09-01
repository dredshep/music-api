import { Hono } from "hono";

export const openapiRoute = new Hono();

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Music Automation API",
    version: "1.0.0",
    description:
      "A semantic music library management API. Searches Soulseek for release candidates, checks Navidrome for matching tracks, compares catalogs via MusicBrainz, and manages logical download jobs. Designed for LLM tool use.",
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
              retry_after_ms: { type: "integer", description: "Suggested retry delay in milliseconds; present when retryable is true and the server can estimate a useful delay" },
            },
            required: ["code", "message", "retryable"],
          },
        },
      },
    },
  },
  paths: {
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
                            scan: {
                              type: "object",
                              description: "Present when Navidrome is available",
                              properties: {
                                scanning: { type: "boolean" },
                                files_scanned: { type: "integer" },
                                folders_scanned: { type: "integer" },
                                library_total_tracks: { type: "integer", nullable: true },
                                progress_percent: { type: "integer", nullable: true },
                                progress_note: { type: "string", nullable: true },
                                last_scan: { type: "string", format: "date-time", nullable: true },
                                scan_type: { type: "string", nullable: true },
                                elapsed_ms: { type: "integer", nullable: true },
                                error: { type: "string", nullable: true },
                              },
                            },
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
        summary: "Check if music is already matched in Navidrome",
        description:
          "Checks Navidrome matching and returns recent Soulseek download jobs for the same artist/title. Includes handoff_hint for lyrics workflow. Set include_songs=true for per-track navidrome IDs when indexed.",
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
                  include_songs: {
                    type: "boolean",
                    default: false,
                    description: "Include songs with navidrome_id on top match when indexed",
                  },
                  include_downloads: {
                    type: "boolean",
                    default: true,
                    description: "Include recent download jobs (last 180 days) for handoff",
                  },
                },
                required: ["artist"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Navidrome matches, download history, and handoff hint",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    matched: { type: "boolean", description: "True when a high-confidence Navidrome album match exists" },
                    indexed: { type: "boolean" },
                    scan: {
                      type: "object",
                      properties: {
                        scanning: { type: "boolean" },
                        files_scanned: { type: "integer" },
                        progress_percent: { type: "integer", nullable: true },
                        library_total_tracks: { type: "integer", nullable: true },
                      },
                    },
                    confidence: { type: "number" },
                    handoff_hint: { type: "string" },
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
                          songs: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                navidrome_id: { type: "string" },
                                track: { type: "integer" },
                                title: { type: "string" },
                                duration_s: { type: "number" },
                              },
                            },
                          },
                        },
                      },
                    },
                    recent_downloads: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          job_id: { type: "string" },
                          status: { type: "string" },
                          audio_files: { type: "array", items: { type: "object" } },
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
    "/v1/navidrome/matches/tracks": {
      post: {
        operationId: "matchNavidromeTracks",
        summary: "Batch-check Navidrome match status for tracks",
        description:
          "Batch-check up to 500 tracks against the whole-library Navidrome snapshot. Returns match status, confidence, and Navidrome IDs. Set refresh_library_snapshot=true to rebuild first. Legacy alias: POST /v1/library/ownership/tracks.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tracks: {
                    type: "array",
                    minItems: 1,
                    maxItems: 500,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        artist: { type: "string" },
                        title: { type: "string" },
                        album: { type: "string" },
                        duration_ms: { type: "integer" },
                      },
                      required: ["id", "artist", "title"],
                    },
                  },
                  refresh_library_snapshot: { type: "boolean", default: false },
                },
                required: ["tracks"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Navidrome match results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          status: {
                            type: "string",
                            enum: ["matched", "possible_match", "not_found", "unchecked"],
                          },
                          confidence: { type: "number" },
                          match: { type: "object", nullable: true },
                        },
                      },
                    },
                    summary: {
                      type: "object",
                      properties: {
                        matched: { type: "integer" },
                        possible_match: { type: "integer" },
                        not_found: { type: "integer" },
                        unchecked: { type: "integer" },
                      },
                    },
                    snapshot_version: { type: "string", nullable: true },
                    snapshot_built_at: { type: "string", nullable: true },
                    snapshot_total: { type: "integer" },
                    snapshot_stale: { type: "boolean" },
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
        summary: "Summarize the Navidrome library",
        description:
          "Library totals plus top artists. Includes on-disk library size when LIBRARY_MUSIC_PATH is configured. by=album_count (default) ranks by collection size; by=play_count ranks by summed album listens. Prefer over searchLibrary for broad taste/overview queries.",
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
                        disk_bytes: {
                          type: "integer",
                          description: "Total on-disk library size in bytes",
                        },
                        disk_gb: {
                          type: "number",
                          description: "Library size in gibibytes (GiB)",
                        },
                        disk_tb: {
                          type: "number",
                          description: "Library size in tebibytes (TiB)",
                        },
                        disk_display: {
                          type: "string",
                          description: "Human-readable library size, e.g. 1.23 TB",
                        },
                        disk_status: {
                          type: "string",
                          enum: ["computing", "unavailable"],
                          description:
                            "Present when disk size is not cached yet or du failed; retry overview after a minute.",
                        },
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
        summary: "List artists in the Navidrome library",
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
        description:
          "Navidrome scan progress: files/folders scanned, approximate progress_percent vs library_total_tracks, last_scan, scan_type, elapsed_ms. Includes cached library_disk when available.",
        responses: {
          "200": {
            description: "Scan status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scanning: { type: "boolean" },
                    files_scanned: { type: "integer" },
                    folders_scanned: { type: "integer" },
                    library_total_tracks: { type: "integer", nullable: true },
                    progress_percent: { type: "integer", nullable: true },
                    progress_note: { type: "string", nullable: true },
                    last_scan: { type: "string", format: "date-time", nullable: true },
                    scan_type: { type: "string", nullable: true },
                    elapsed_ms: { type: "integer", nullable: true },
                    error: { type: "string", nullable: true },
                    library_disk: {
                      type: "object",
                      nullable: true,
                      properties: {
                        bytes: { type: "integer" },
                        display: { type: "string" },
                      },
                    },
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
          "Local-first catalog comparison. Uses cached MusicBrainz release groups when fresh; refreshes from MB only when stale (>30d) or force_refresh=true. When MusicBrainz is unavailable but a cached catalog exists, returns degraded results with catalog_degraded: true.",
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
                    catalog_degraded: { type: "boolean", description: "True when MusicBrainz refresh failed and stale cached data was used" },
                    warnings: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          code: { type: "string" },
                          message: { type: "string" },
                        },
                        required: ["code", "message"],
                      },
                      description: "Non-fatal warnings about data freshness or upstream issues",
                    },
                    summary: {
                      type: "object",
                      properties: {
                        catalog_releases: { type: "integer" },
                        matched: { type: "integer" },
                        not_found: { type: "integer" },
                        possible_match: { type: "integer" },
                      },
                    },
                    missing: { type: "array", items: { type: "object" } },
                    uncertain: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
          "503": {
            description: "MusicBrainz unavailable and no cached catalog exists",
            headers: {
              "Retry-After": {
                schema: { type: "integer" },
                description: "Suggested retry delay in seconds",
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
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
                        total_matched: { type: "integer" },
                        total_not_found: { type: "integer" },
                        total_possible_match: { type: "integer" },
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
          "Search Soulseek for artist/title, enrich directories, score candidates, and return ranked results with opaque candidate IDs. Response includes lifecycle and diagnostics; if state is collecting and candidates are empty, refresh via refreshMusicSearch after recommended_refresh_after_ms.",
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
                    description: "Affects completeness scoring: single/track accept 1+ tracks as complete; album uses track-count heuristics.",
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
            description: "Search results with ranked candidates, lifecycle, and diagnostics",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    search_id: { type: "string" },
                    query: { type: "object" },
                    lifecycle: {
                      type: "object",
                      description: "Search lifecycle state — check before treating an empty result as final",
                      properties: {
                        state: { type: "string", enum: ["collecting", "settled", "expired"] },
                        age_ms: { type: "integer" },
                        collection_ms: { type: "integer" },
                        settled: { type: "boolean" },
                        last_new_result_at: { type: "string", format: "date-time", nullable: true },
                        recommended_refresh_after_ms: { type: "integer", nullable: true, description: "If non-null, client should refresh after this many ms to get more results" },
                      },
                    },
                    diagnostics: {
                      type: "object",
                      description: "Internal counters for debugging search quality issues",
                      properties: {
                        raw_file_count: { type: "integer" },
                        locked_file_count: { type: "integer" },
                        peer_response_count: { type: "integer" },
                        unique_peers: { type: "integer" },
                        unique_directories: { type: "integer" },
                        audio_directories: { type: "integer" },
                        lrc_directories: { type: "integer", description: "Directories containing .lrc files" },
                        collection_ms: { type: "integer" },
                        enrichment_successes: { type: "integer" },
                        enrichment_failures: { type: "integer" },
                      },
                    },
                    warnings: {
                      type: "array",
                      items: { type: "string", enum: ["raw_results_without_candidates", "search_still_collecting", "partial_upstream_failure"] },
                      description: "Non-fatal warnings. raw_results_without_candidates means slskd returned files but none passed candidate filters.",
                    },
                    candidates: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", description: "Opaque candidate ID for use with enqueueCandidate. Stable across refreshes." },
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
          "Re-poll slskd for new peer responses, upsert candidates with stable IDs, and re-rank. Returns immediately when candidates exist; otherwise waits up to 15s while collecting. Check lifecycle.state before treating empty results as final. HTTP 410 if expired.",
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
          "200": { description: "Updated search results with lifecycle metadata" },
          "410": { description: "Search expired" },
        },
      },
    },
    "/v1/acquire/preview": {
      post: {
        operationId: "previewAcquire",
        summary: "Check Navidrome match then search if not found",
        description:
          "Convenience endpoint that first checks Navidrome for a matching album. If confidently matched in Navidrome, returns the library match. Otherwise, performs a Soulseek search and returns candidates. No download occurs. This is typically the first call for 'find me this album'.",
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
            description: "Navidrome match status and candidates if not found in Navidrome",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["matched", "not_found"] },
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
          "Download a candidate from searchMusic, refreshMusicSearch, or previewAcquire. Includes audio, matching LRC, cover, and sidecars. Idempotent. Use matched_only with track_title for a single track plus its .lrc.",
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
                  matched_only: {
                    type: "boolean",
                    default: false,
                    description: "Download only the matched track file plus its .lrc sidecar and cover art",
                  },
                  track_title: {
                    type: "string",
                    description: "Required when matched_only=true. The track title to match against file names in the candidate directory.",
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
          "List download jobs. Default active only. With artist/release/q filters, defaults to all statuses and searches job history (not slskd's live window). Use include_files=true for audio filenames.",
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
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "artist", in: "query", schema: { type: "string" }, description: "Filter by artist substring" },
          { name: "release", in: "query", schema: { type: "string" }, description: "Filter by release title substring" },
          { name: "q", in: "query", schema: { type: "string" }, description: "Filter artist or release substring" },
          { name: "since_days", in: "query", schema: { type: "integer" }, description: "Only jobs from the last N days" },
          { name: "include_files", in: "query", schema: { type: "boolean", default: false } },
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
        description: "Runs the full recommendation pipeline: fetches seeds from Last.fm, generates candidates from similar artists / ListenBrainz / new releases, canonicalizes via MusicBrainz, filters matched, scores, and persists. Returns generation summary.",
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
                  include_possible_match: { type: "boolean", description: "Include possible match candidates" },
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
        description: "Returns scored recommendations with full provenance. Defaults to active, not found in Navidrome, non-suppressed items sorted by score descending.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "type", in: "query", schema: { type: "string", enum: ["artist", "release_group", "any"] } },
          { name: "reason", in: "query", schema: { type: "string", enum: ["similar_to_recent", "similar_to_favorite", "collaborative", "new_release", "wildcard"] } },
          { name: "min_score", in: "query", schema: { type: "number" } },
          { name: "include_matched", in: "query", schema: { type: "boolean", default: false } },
          { name: "include_possible_match", in: "query", schema: { type: "boolean", default: false } },
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
    "/v1/lyrics/search": {
      post: {
        operationId: "searchLyrics",
        summary: "Search LRCLIB for synced lyrics candidates",
        description:
          "Searches lrclib.net for lyrics matching artist, title, and optional album/duration. Returns ranked candidates with confidence scores. Use acquireLyrics (dry_run) to preview before writing.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["artist", "title"],
                properties: {
                  artist: { type: "string" },
                  title: { type: "string" },
                  album: { type: "string" },
                  duration_s: { type: "number", description: "Track duration in seconds. Improves matching precision." },
                  max_results: { type: "integer", default: 10, maximum: 50 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Lyric candidates",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    candidates: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          lrclib_id: { type: "integer", description: "Use this ID with acquireLyrics" },
                          artist: { type: "string" },
                          title: { type: "string" },
                          album: { type: "string" },
                          duration_s: { type: "number" },
                          duration_delta_s: { type: "number", nullable: true },
                          instrumental: { type: "boolean" },
                          has_synced: { type: "boolean" },
                          has_plain: { type: "boolean" },
                          match_type: { type: "string", enum: ["exact", "search"] },
                          confidence: { type: "number" },
                        },
                      },
                    },
                    count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/lyrics/acquire": {
      post: {
        operationId: "acquireLyrics",
        summary: "Write a .lrc sidecar for a Navidrome song",
        description:
          "Downloads lyrics from LRCLIB and writes a .lrc file next to the audio file in the library. If the library mount is read-only, lyrics are staged to the data dir instead. Triggers a Navidrome scan on success. Does not overwrite existing .lrc files.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["lrclib_id", "navidrome_song_id"],
                properties: {
                  lrclib_id: { type: "integer", description: "LRCLIB track ID from searchLyrics" },
                  navidrome_song_id: { type: "string", description: "Navidrome song ID" },
                  synced_only: { type: "boolean", default: true, description: "Reject if only plain lyrics available" },
                  dry_run: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Lyrics deployed to library" },
          "200": { description: "Lyrics staged (library read-only)" },
          "409": { description: ".lrc file already exists" },
          "422": { description: "No suitable lyrics available" },
        },
      },
    },
    "/v1/lyrics/audit": {
      post: {
        operationId: "auditReleaseLyrics",
        summary: "Audit a release for per-track LRC coverage",
        description:
          "Checks each track in a Navidrome album for .lrc presence on disk and LRCLIB availability. Use this to decide which tracks to fill.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  navidrome_album_id: { type: "string", description: "Navidrome album ID. Preferred." },
                  artist: { type: "string", description: "Alternative: search by artist + album" },
                  album: { type: "string", description: "Alternative: search by artist + album" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Per-track LRC audit",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    album: { type: "object" },
                    coverage: {
                      type: "object",
                      properties: {
                        synced: { type: "integer" },
                        missing: { type: "integer" },
                        total: { type: "integer" },
                        ratio: { type: "number" },
                      },
                    },
                    tracks: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          track: { type: "integer" },
                          title: { type: "string" },
                          navidrome_id: { type: "string" },
                          duration_s: { type: "number" },
                          lrc_status: { type: "string", enum: ["present_synced", "present_plain", "missing", "unknown"] },
                          lrclib_available: { type: "boolean" },
                          lrclib_best_confidence: { type: "number" },
                          lrclib_has_synced: { type: "boolean" },
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
    "/v1/lyrics/fill": {
      post: {
        operationId: "fillMissingLyrics",
        summary: "Batch-fill missing .lrc files for a Navidrome album",
        description:
          "For each track missing a .lrc file, searches LRCLIB and writes the best match. Skips tracks that already have .lrc files. Use dry_run=true (default) to preview what would be filled before committing.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["navidrome_album_id"],
                properties: {
                  navidrome_album_id: { type: "string" },
                  synced_only: { type: "boolean", default: true, description: "Only fill with synced (timestamped) lyrics" },
                  min_confidence: { type: "number", default: 0.8, description: "Minimum match confidence 0-1" },
                  dry_run: { type: "boolean", default: true, description: "Preview without writing files" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Fill results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    album: { type: "object" },
                    dry_run: { type: "boolean" },
                    summary: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        filled: { type: "integer" },
                        skipped: { type: "integer" },
                        failed: { type: "integer" },
                      },
                    },
                    tracks: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
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
    navidrome_match: {
      type: "object",
      properties: { status: { type: "string", enum: ["matched", "not_found", "possible_match", "unchecked"] } },
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

/** Full spec for tests and build-time validation. */
export function getOpenApiSpec(): typeof spec {
  return spec;
}
