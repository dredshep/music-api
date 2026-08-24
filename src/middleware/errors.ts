import type { MiddlewareHandler } from "hono";
import { log } from "./logging";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 500,
    public retryable: boolean = false,
    public details?: unknown,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "AppError";
  }
}

function isAppError(err: unknown): err is AppError {
  return (
    err instanceof AppError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "AppError" &&
      typeof (err as { code?: unknown }).code === "string" &&
      typeof (err as { status?: unknown }).status === "number")
  );
}

const UPSTREAM_CODES = new Set([
  "SLSKD_UNAVAILABLE",
  "SLSKD_RATE_LIMITED",
  "NAVIDROME_UNAVAILABLE",
  "MUSICBRAINZ_ERROR",
  "MUSICBRAINZ_UNAVAILABLE",
  "MUSICBRAINZ_RATE_LIMITED",
  "LASTFM_ERROR",
  "LISTENBRAINZ_ERROR",
  "LRCLIB_ERROR",
]);

const SANITIZED_MESSAGES: Record<string, string> = {
  SLSKD_UNAVAILABLE: "Soulseek service is temporarily unavailable",
  SLSKD_RATE_LIMITED: "Soulseek search rate limit reached",
  NAVIDROME_UNAVAILABLE: "Library service is temporarily unavailable",
  MUSICBRAINZ_ERROR: "Metadata service is temporarily unavailable",
  MUSICBRAINZ_UNAVAILABLE: "Metadata service is temporarily unavailable",
  MUSICBRAINZ_RATE_LIMITED: "Metadata service is temporarily unavailable",
  LASTFM_ERROR: "Last.fm service is temporarily unavailable",
  LISTENBRAINZ_ERROR: "ListenBrainz service is temporarily unavailable",
  LRCLIB_ERROR: "Lyrics service is temporarily unavailable",
};

export function formatErrorResponse(err: unknown): {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
} {
  if (isAppError(err)) {
    log("warn", "app_error", {
      code: err.code,
      message: err.message,
      status: err.status,
      details: err.details,
    });

    const isUpstream = UPSTREAM_CODES.has(err.code);
    const error: Record<string, unknown> = {
      code: err.code,
      message: isUpstream ? (SANITIZED_MESSAGES[err.code] ?? "Upstream service error") : err.message,
      retryable: err.retryable,
    };
    if (!isUpstream && err.details) error.details = err.details;
    if (err.retryAfterMs != null) error.retry_after_ms = err.retryAfterMs;

    const retryAfterSeconds =
      err.retryAfterMs != null ? Math.ceil(err.retryAfterMs / 1000) : undefined;

    return { status: err.status, body: { error }, retryAfterSeconds };
  }

  const message =
    err instanceof Error ? err.message : "An unexpected error occurred";

  log("error", "unhandled_error", {
    message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred",
        retryable: true,
      },
    },
  };
}

export function errorHandler(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const { status, body, retryAfterSeconds } = formatErrorResponse(err);
      if (retryAfterSeconds != null) {
        c.header("Retry-After", String(retryAfterSeconds));
      }
      return c.json(body, status as 400);
    }
  };
}
