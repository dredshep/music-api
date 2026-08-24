import { describe, test, expect, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { AppError, formatErrorResponse } from "../src/middleware/errors";
import { getOpenApiSpec } from "../src/routes/openapi";
import { getInflightCount } from "../src/services/musicbrainz";

// The musicbrainz module needs DB for getCache — point to an in-memory DB.
process.env.DATABASE_PATH = ":memory:";
import { initDatabase } from "../src/db/database";
import { resetConfigForTests } from "../src/config";
resetConfigForTests();
initDatabase();

// ---------------------------------------------------------------------------
// 1. AppError + formatErrorResponse
// ---------------------------------------------------------------------------

describe("AppError retryAfterMs", () => {
  test("carries retryAfterMs through constructor", () => {
    const err = new AppError("MUSICBRAINZ_UNAVAILABLE", "down", 503, true, undefined, 3000);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retryable).toBe(true);
  });

  test("retryAfterMs defaults to undefined", () => {
    const err = new AppError("VALIDATION_ERROR", "bad input", 400);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("formatErrorResponse", () => {
  test("MUSICBRAINZ_UNAVAILABLE returns sanitized message with retry_after_ms", () => {
    const err = new AppError(
      "MUSICBRAINZ_UNAVAILABLE",
      "unknown certificate verification error",
      503,
      true,
      undefined,
      3000
    );
    const { status, body, retryAfterSeconds } = formatErrorResponse(err);

    expect(status).toBe(503);
    expect(retryAfterSeconds).toBe(3);

    const error = (body as { error: Record<string, unknown> }).error;
    expect(error.code).toBe("MUSICBRAINZ_UNAVAILABLE");
    expect(error.message).toBe("Metadata service is temporarily unavailable");
    expect(error.retryable).toBe(true);
    expect(error.retry_after_ms).toBe(3000);
    // Raw TLS message must not leak
    expect(JSON.stringify(body)).not.toContain("certificate");
  });

  test("MUSICBRAINZ_RATE_LIMITED returns sanitized message", () => {
    const err = new AppError(
      "MUSICBRAINZ_RATE_LIMITED",
      "429 from upstream",
      503,
      true,
      undefined,
      5000
    );
    const { status, body, retryAfterSeconds } = formatErrorResponse(err);

    expect(status).toBe(503);
    expect(retryAfterSeconds).toBe(5);

    const error = (body as { error: Record<string, unknown> }).error;
    expect(error.code).toBe("MUSICBRAINZ_RATE_LIMITED");
    expect(error.message).toBe("Metadata service is temporarily unavailable");
    expect(error.retry_after_ms).toBe(5000);
    expect(JSON.stringify(body)).not.toContain("429");
  });

  test("does not leak raw certificate text in MUSICBRAINZ_UNAVAILABLE", () => {
    const rawMsg = "unable to get issuer certificate (SSL routines::certificate verify failed)";
    const err = new AppError("MUSICBRAINZ_UNAVAILABLE", rawMsg, 503, true, undefined, 3000);
    const { body } = formatErrorResponse(err);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("certificate");
    expect(serialised).not.toContain("SSL");
    expect(serialised).not.toContain("issuer");
  });

  test("does not emit retry_after_ms for non-retryable errors", () => {
    const err = new AppError("VALIDATION_ERROR", "bad input", 400);
    const { retryAfterSeconds, body } = formatErrorResponse(err);
    expect(retryAfterSeconds).toBeUndefined();
    expect((body as { error: Record<string, unknown> }).error.retry_after_ms).toBeUndefined();
  });

  test("validation errors remain non-retryable", () => {
    const err = new AppError("VALIDATION_ERROR", "missing field", 400);
    const { status, body } = formatErrorResponse(err);
    expect(status).toBe(400);
    expect((body as { error: Record<string, unknown> }).error.retryable).toBe(false);
  });

  test("ARTIST_NOT_FOUND returns 404 non-retryable", () => {
    const err = new AppError("ARTIST_NOT_FOUND", 'No results for "Nope"', 404);
    const { status, body } = formatErrorResponse(err);
    expect(status).toBe(404);
    const error = (body as { error: Record<string, unknown> }).error;
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("ARTIST_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// 2. MusicBrainz fetch retry behaviour (unit, mocked fetch)
// ---------------------------------------------------------------------------

describe("musicbrainz rateLimitedFetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string }>;

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(responses: Array<{ status?: number; body?: unknown; throw?: Error; headers?: Record<string, string> }>) {
    let idx = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls.push({ url: String(input) });
      const spec = responses[idx++];
      if (!spec) throw new Error("unexpected fetch call");
      if (spec.throw) throw spec.throw;
      return new Response(JSON.stringify(spec.body ?? {}), {
        status: spec.status ?? 200,
        headers: {
          "Content-Type": "application/json",
          ...(spec.headers ?? {}),
        },
      });
    }) as typeof fetch;
  }

  // Dynamic import to pick up our mock — import after stub is set
  async function importMb() {
    // Reset the module cache so rateLimitedFetch sees the new global.fetch
    // We clear cache by leveraging Bun's import with hash-busting, but
    // since we can't bust module cache in Bun easily, we test via the
    // public API which calls rateLimitedFetch internally.
    // The service module was already imported at the top for getInflightCount.
    // We'll use searchArtist as our proxy since it calls rateLimitedFetch.
    const mod = await import("../src/services/musicbrainz");
    return mod;
  }

  test("TLS failure on first attempt retries and succeeds", async () => {
    const tlsError = new TypeError(
      "unable to get issuer certificate (SSL routines::certificate verify failed)"
    );
    stubFetch([
      { throw: tlsError },
      { status: 200, body: { artists: [{ id: "abc", name: "Test", "sort-name": "Test" }], count: 1, offset: 0 } },
    ]);

    const mb = await importMb();
    const results = await mb.searchArtist("Test", 1);

    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Test");
    expect(fetchCalls.length).toBe(2);
  });

  test("two TLS failures produce sanitized 503 with retry_after_ms", async () => {
    const tlsError = new TypeError("certificate verify failed");
    stubFetch([
      { throw: tlsError },
      { throw: tlsError },
    ]);

    const mb = await importMb();
    try {
      await mb.searchArtist("Fail", 1);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe("MUSICBRAINZ_UNAVAILABLE");
      expect(appErr.status).toBe(503);
      expect(appErr.retryable).toBe(true);
      expect(appErr.retryAfterMs).toBe(3000);
      // Raw cert message stays internal
      expect(appErr.message).toContain("certificate");

      // But the formatted response sanitizes it
      const { body } = formatErrorResponse(appErr);
      expect(JSON.stringify(body)).not.toContain("certificate");
    }
  });

  test("HTTP 429 produces MUSICBRAINZ_RATE_LIMITED with Retry-After derived delay", async () => {
    stubFetch([
      { status: 429, headers: { "Retry-After": "10" } },
    ]);

    const mb = await importMb();
    try {
      await mb.searchArtist("RateLimited", 1);
      expect(true).toBe(false);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe("MUSICBRAINZ_RATE_LIMITED");
      expect(appErr.status).toBe(503);
      expect(appErr.retryAfterMs).toBe(10000);
    }
  });

  test("HTTP 429 clamps Retry-After to 60 seconds max", async () => {
    stubFetch([
      { status: 429, headers: { "Retry-After": "300" } },
    ]);

    const mb = await importMb();
    try {
      await mb.searchArtist("RateLimited2", 1);
      expect(true).toBe(false);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.retryAfterMs).toBe(60000);
    }
  });

  test("HTTP 503 retries once then throws on second 503", async () => {
    stubFetch([
      { status: 503 },
      { status: 503 },
    ]);

    const mb = await importMb();
    try {
      await mb.searchArtist("Down", 1);
      expect(true).toBe(false);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe("MUSICBRAINZ_UNAVAILABLE");
      expect(appErr.status).toBe(503);
      expect(fetchCalls.length).toBe(2);
    }
  });

  test("in-flight map is cleared after failure", async () => {
    const tlsError = new TypeError("certificate verify failed");
    stubFetch([
      { throw: tlsError },
      { throw: tlsError },
    ]);

    const mb = await importMb();
    try {
      await mb.searchArtist("Cleanup", 1);
    } catch {
      // expected
    }

    expect(mb.getInflightCount()).toBe(0);
  });

  test("invalid JSON on first attempt retries and succeeds", async () => {
    // Need custom fetch to return invalid JSON on first attempt
    let callNum = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callNum++;
      fetchCalls.push({ url: String(_input) });
      if (callNum === 1) {
        return new Response("not valid json {{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ artists: [{ id: "x", name: "Ok", "sort-name": "Ok" }], count: 1, offset: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const mb = await importMb();
    const results = await mb.searchArtist("JsonRetry", 1);
    expect(results.length).toBe(1);
    expect(fetchCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. OpenAPI schema contract
// ---------------------------------------------------------------------------

describe("OpenAPI catalog error contract", () => {
  const spec = getOpenApiSpec();

  test("Error schema has retry_after_ms field", () => {
    const errorSchema = (spec.components.schemas as Record<string, Record<string, unknown>>)["Error"];
    const errorProps = (errorSchema as { properties: { error: { properties: Record<string, unknown> } } }).properties.error.properties;
    expect(errorProps).toHaveProperty("retry_after_ms");
  });

  test("getMissingCatalog has 503 response", () => {
    const catalog = spec.paths["/v1/catalog/missing"];
    expect(catalog.post.responses).toHaveProperty("503");
  });

  test("getMissingCatalog 200 response includes catalog_degraded and warnings", () => {
    const schema = spec.paths["/v1/catalog/missing"].post.responses["200"]
      .content["application/json"].schema;
    expect(schema.properties).toHaveProperty("catalog_degraded");
    expect(schema.properties).toHaveProperty("warnings");
  });
});
