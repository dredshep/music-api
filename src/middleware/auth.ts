import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config";

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid API key",
            retryable: false,
          },
        },
        401
      );
    }

    const token = authHeader.slice(7);
    const config = getConfig();

    if (token !== config.API_KEY) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid API key",
            retryable: false,
          },
        },
        401
      );
    }

    await next();
  };
}
