import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config";
import { recordAuthFailure, getClientIp } from "./rate-limit";

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    const dummy = encoder.encode(a);
    let _sink = 0;
    for (let i = 0; i < dummy.byteLength; i++) _sink |= dummy[i]! ^ dummy[i]!;
    void _sink;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      recordAuthFailure(getClientIp(c));
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization", retryable: false } },
        401
      );
    }

    const token = authHeader.slice(7);
    const config = getConfig();

    if (!timingSafeEqual(token, config.API_KEY)) {
      recordAuthFailure(getClientIp(c));
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid API key", retryable: false } },
        401
      );
    }

    await next();
  };
}
