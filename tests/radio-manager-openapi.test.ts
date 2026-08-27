import { describe, expect, test } from "bun:test";
import { getManagerRadioOpenApiSpec } from "../src/routes/openapi-manager-radio";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("Manager Radio OpenAPI", () => {
  test("documents workstation-only Radio operations separately from the agent spec", () => {
    const spec = getManagerRadioOpenApiSpec();
    const paths = Object.keys(spec.paths);
    expect(paths.every((path) => path.startsWith("/manager/v1/radio/"))).toBe(true);
    expect(paths).toContain("/manager/v1/radio/stations/{id}/live-batch");
    expect(paths).toContain("/manager/v1/radio/generations/{id}/regenerate-tail");
    expect(paths).toContain("/manager/v1/radio/generations/{id}/import-external");
    expect(paths).toContain("/manager/v1/radio/generations/{id}/analyze");
    expect(paths).toContain("/manager/v1/radio/audio-analysis/status");
  });

  test("uses unique operation IDs", () => {
    const operations = Object.values(getManagerRadioOpenApiSpec().paths).flatMap((item) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = (item as Record<string, { operationId?: string }>)[method];
        return operation?.operationId ? [operation.operationId] : [];
      }),
    );
    expect(new Set(operations).size).toBe(operations.length);
  });
});
