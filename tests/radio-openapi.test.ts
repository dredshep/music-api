import { describe, expect, test } from "bun:test";
import { getRadioOpenApiSpec } from "../src/routes/openapi-radio";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("Radio OpenAPI", () => {
  test("stays a small semantic agent surface", () => {
    const spec = getRadioOpenApiSpec();
    const operations = Object.values(spec.paths).flatMap((item) =>
      HTTP_METHODS.flatMap((method) => {
        const op = (item as Record<string, { operationId?: string; description?: string }>)[method];
        return op?.operationId ? [op] : [];
      }),
    );
    expect(operations.length).toBeLessThanOrEqual(10);
    expect(new Set(operations.map((op) => op.operationId)).size).toBe(operations.length);
    expect(operations.filter((op) => (op.description?.length ?? 0) > 300)).toEqual([]);
  });

  test("documents finite creation, saved generations and explicit feedback", () => {
    const paths = new Set(Object.keys(getRadioOpenApiSpec().paths));
    expect(paths.has("/v1/radio/stations")).toBe(true);
    expect(paths.has("/v1/radio/stations/{id}/generate")).toBe(true);
    expect(paths.has("/v1/radio/generations/{id}")).toBe(true);
    expect(paths.has("/v1/radio/feedback")).toBe(true);
  });

  test("does not leak manager-only mutation and workstation routes", () => {
    const paths = Object.keys(getRadioOpenApiSpec().paths);
    const forbiddenFragments = [
      "/clone",
      "/reorder",
      "/revisions",
      "/regenerate-tail",
      "/import-external",
      "/resolve",
      "/analyze",
      "/tracks/",
    ];
    for (const fragment of forbiddenFragments) {
      expect(paths.some((path) => path.includes(fragment))).toBe(false);
    }
  });
});
