import { describe, expect, test } from "bun:test";
import { catalogIndexRoutes } from "../src/routes/catalog-index";
import { formatErrorResponse } from "../src/middleware/errors";

catalogIndexRoutes.onError((error, c) => {
  const { status, body } = formatErrorResponse(error);
  return c.json(body, status as 400);
});

describe("catalog index validation", () => {
  test("rejects inverted year ranges before touching upstream services", async () => {
    const response = await catalogIndexRoutes.request("/catalog/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ year_from: 2026, year_to: 2025 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("year_from");
  });

  test("rejects oversized artist cohorts", async () => {
    const response = await catalogIndexRoutes.request("/catalog/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artist_names: Array.from({ length: 1001 }, (_, index) => `Artist ${index}`) }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
