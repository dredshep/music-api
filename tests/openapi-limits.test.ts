import { describe, test, expect } from "bun:test";
import { getOpenApiSpec } from "../src/routes/openapi";

const MAX_OPERATION_DESCRIPTION_LENGTH = 300;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

describe("OpenAPI GPT Actions limits", () => {
  test("operation descriptions are at most 300 characters", () => {
    const spec = getOpenApiSpec();
    const violations: string[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation?.operationId) continue;

        const description = operation.description;
        if (typeof description !== "string") continue;

        if (description.length > MAX_OPERATION_DESCRIPTION_LENGTH) {
          violations.push(
            `${method.toUpperCase()} ${path} (${operation.operationId}): ${description.length}`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
