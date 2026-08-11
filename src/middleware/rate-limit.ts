import type { MiddlewareHandler } from "hono";
import { log } from "./logging";

interface BucketEntry {
  count: number;
  resetAt: number;
  blockedUntil: number;
}

const MAX_MAP_SIZE = 10_000;

class RateLimitBucket {
  private map = new Map<string, BucketEntry>();
  constructor(
    private maxHits: number,
    private windowMs: number,
    private blockMs: number
  ) {}

  isBlocked(key: string): { blocked: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const entry = this.map.get(key);
    if (entry && entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }
    return { blocked: false };
  }

  check(key: string): { allowed: boolean; retryAfterMs?: number } {
    this.evictIfNeeded();
    const now = Date.now();
    let entry = this.map.get(key);

    if (entry && entry.blockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    }

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs, blockedUntil: 0 };
      this.map.set(key, entry);
    }

    entry.count++;

    if (entry.count > this.maxHits) {
      entry.blockedUntil = now + this.blockMs;
      return { allowed: false, retryAfterMs: this.blockMs };
    }

    return { allowed: true };
  }

  private evictIfNeeded() {
    if (this.map.size <= MAX_MAP_SIZE) return;
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.resetAt <= now && entry.blockedUntil <= now) {
        this.map.delete(key);
      }
      if (this.map.size <= MAX_MAP_SIZE * 0.8) break;
    }
  }
}

const failBucket = new RateLimitBucket(10, 5 * 60_000, 15 * 60_000);
const publicBucket = new RateLimitBucket(60, 60_000, 60_000);
const authBucket = new RateLimitBucket(120, 60_000, 30_000);

export function recordAuthFailure(ip: string): void {
  failBucket.check(ip);
}

export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-real-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export function failBanMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c);
    const result = failBucket.isBlocked(ip);

    if (result.blocked) {
      log("warn", "rate_limit_blocked", { ip, bucket: "auth_fail", retry_ms: result.retryAfterMs });
      c.header("Retry-After", String(Math.ceil((result.retryAfterMs ?? 60_000) / 1000)));
      return c.json({ error: { code: "RATE_LIMITED", message: "Too many failed attempts", retryable: true } }, 429);
    }

    await next();
  };
}

export function publicRateLimit(): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c);
    const check = publicBucket.check(ip);
    if (!check.allowed) {
      c.header("Retry-After", String(Math.ceil((check.retryAfterMs ?? 60_000) / 1000)));
      return c.json({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded", retryable: true } }, 429);
    }
    await next();
  };
}

export function authenticatedRateLimit(): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c);
    const check = authBucket.check(ip);
    if (!check.allowed) {
      c.header("Retry-After", String(Math.ceil((check.retryAfterMs ?? 30_000) / 1000)));
      return c.json({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded", retryable: true } }, 429);
    }
    await next();
  };
}
