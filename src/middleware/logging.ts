import type { MiddlewareHandler } from "hono";
import { ulid } from "ulid";

export function log(
  level: "info" | "warn" | "error" | "debug",
  event: string,
  data?: Record<string, unknown>
): void {
  const entry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Fields worth surfacing from ChatGPT / agent request bodies. */
const INTERESTING_BODY_KEYS = [
  "artist",
  "title",
  "candidate_id",
  "job_id",
  "search_id",
  "musicbrainz_id",
  "release_type",
  "release_types",
  "action",
  "force_refresh",
  "preferred_formats",
  "max_candidates",
  "min_missing",
  "limit_artists",
  "include_releases",
  "sort",
  "limit",
  "query",
  "full",
  "type",
  "dedupe_key",
  "component",
  "severity",
  "status",
  "request_id",
] as const;

function summarizeBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of INTERESTING_BODY_KEYS) {
    if (key in src && src[key] !== undefined) {
      out[key] = src[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function summarizeQuery(url: URL): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k.toLowerCase() === "authorization" || k.toLowerCase().includes("key")) {
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type AppVariables = {
  requestId: string;
};

export function loggingMiddleware(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id")?.trim();
    const requestId = incoming && incoming.length > 0 ? incoming : `req_${ulid()}`;
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);

    const start = performance.now();
    const method = c.req.method;
    const path = c.req.path;
    const url = new URL(c.req.url);

    let requestSummary: Record<string, unknown> | undefined;
    const query = summarizeQuery(url);

    if (method !== "GET" && method !== "HEAD") {
      try {
        const body = await c.req.raw.clone().json();
        requestSummary = summarizeBody(body);
      } catch {
        // non-JSON body — ignore
      }
    }

    await next();

    const duration = Math.round(performance.now() - start);
    const status = c.res.status;

    log("info", "http_request", {
      request_id: requestId,
      method,
      path,
      status,
      duration_ms: duration,
      ...(query ? { query } : {}),
      ...(requestSummary ? { body: requestSummary } : {}),
    });
  };
}
