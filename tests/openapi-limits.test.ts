import { describe, test, expect } from "bun:test";
import { getOpenApiSpec } from "../src/routes/openapi";
import { getManagerOpenApiSpec } from "../src/routes/openapi-manager";

const MAX_OPERATION_DESCRIPTION_LENGTH = 300;
const MAX_OPERATIONS = 31;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const MANAGER_ONLY_PATHS = [
  "/v1/player/stream/{id}",
  "/v1/player/download/{id}",
  "/v1/player/cover/{id}",
  "/v1/player/song/{id}",
  "/v1/player/lyrics/{id}",
  "/v1/player/scrobble",
  "/v1/player/star",
  "/v1/player/lyrics/sidecar",
  "/v1/library/songs",
  "/v1/library/albums",
  "/v1/library/albums/{id}",
  "/v1/library/artists/{id}",
  "/v1/library/starred",
  "/v1/library/genres",
  "/v1/library/delete",
  "/v1/downloads/{job_id}/files",
  "/v1/downloads/{job_id}/files/{file_id}/control",
] as const;

function operations(spec: ReturnType<typeof getOpenApiSpec>) {
  return Object.entries(spec.paths).flatMap(([path, pathItem]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = (pathItem as Record<string, { operationId?: string; description?: string }>)[method];
      return operation?.operationId ? [{ path, method, operation }] : [];
    }),
  );
}

describe("OpenAPI GPT Actions limits", () => {
  test("contains at most 31 operations", () => {
    expect(operations(getOpenApiSpec()).length).toBeLessThanOrEqual(MAX_OPERATIONS);
  });

  test("operation descriptions are at most 300 characters", () => {
    const violations = operations(getOpenApiSpec())
      .filter(({ operation }) => typeof operation.description === "string" && operation.description.length > MAX_OPERATION_DESCRIPTION_LENGTH)
      .map(({ path, method, operation }) => `${method.toUpperCase()} ${path} (${operation.operationId}): ${operation.description!.length}`);

    expect(violations).toEqual([]);
  });

  test("manager-only routes are excluded", () => {
    const paths = new Set(Object.keys(getOpenApiSpec().paths));
    expect(MANAGER_ONLY_PATHS.filter((path) => paths.has(path))).toEqual([]);
  });
});

describe("Manager OpenAPI spec", () => {
  const REQUIRED_MANAGER_PATHS = [
    "/manager/v1/soulseek/searches",
    "/manager/v1/soulseek/semantic-searches/{id}/refresh",
    "/manager/v1/soulseek/semantic-searches/{id}/research",
    "/manager/v1/soulseek/transfers/downloads",
    "/manager/v1/soulseek/transfers/uploads",
    "/manager/v1/soulseek/transfers/cancel",
    "/manager/v1/soulseek/users/{username}/info",
    "/manager/v1/soulseek/history",
    "/manager/v1/soulseek/stats",
    "/manager/v1/soulseek/peers",
    "/manager/v1/soulseek/messages",
  ] as const;

  test("contains required manager routes", () => {
    const paths = new Set(Object.keys(getManagerOpenApiSpec().paths));
    const missing = REQUIRED_MANAGER_PATHS.filter((p) => !paths.has(p));
    expect(missing).toEqual([]);
  });

  test("raw slskd IDs are not reused as semantic-action routes", () => {
    const paths = new Set(Object.keys(getManagerOpenApiSpec().paths));
    expect(paths.has("/manager/v1/soulseek/searches/{id}/refresh")).toBe(false);
    expect(paths.has("/manager/v1/soulseek/searches/{id}/research")).toBe(false);
  });

  test("no agent API paths leak into manager spec", () => {
    const paths = Object.keys(getManagerOpenApiSpec().paths);
    const agentPaths = paths.filter(
      (p) => p.startsWith("/v1/") && !p.startsWith("/manager/")
    );
    expect(agentPaths).toEqual([]);
  });

  test("manager spec has valid OpenAPI version", () => {
    expect(getManagerOpenApiSpec().openapi).toBe("3.1.0");
  });

  test("all manager operations have operationIds", () => {
    const ops = operations(getManagerOpenApiSpec() as ReturnType<typeof getOpenApiSpec>);
    const missing = ops.filter((o) => !o.operation.operationId);
    expect(missing).toEqual([]);
  });
});
