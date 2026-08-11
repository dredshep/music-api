import type { MiddlewareHandler } from "hono";
import { log } from "./logging";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 500,
    public retryable: boolean = false,
    public details?: unknown
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

export function formatErrorResponse(err: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (isAppError(err)) {
    log("warn", "app_error", {
      code: err.code,
      message: err.message,
      status: err.status,
    });

    const error: Record<string, unknown> = {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
    };
    if (err.details) error.details = err.details;

    return { status: err.status, body: { error } };
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
        code: "UPSTREAM_ERROR",
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
      const { status, body } = formatErrorResponse(err);
      return c.json(body, status as 400);
    }
  };
}
