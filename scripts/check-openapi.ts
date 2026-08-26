import { getOpenApiSpec } from "../src/routes/openapi";

const MAX_OPERATION_DESCRIPTION_LENGTH = 300;
const MAX_OPERATIONS = 30;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// These routes exist for Music Manager's internal/BFF use. They must not consume
// ChatGPT Actions' operation budget or expose playback/filesystem primitives.
const MANAGER_ONLY_PATHS = new Set([
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
]);

const spec = getOpenApiSpec();
const violations: string[] = [];
let operationCount = 0;

for (const [path, pathItem] of Object.entries(spec.paths)) {
  if (MANAGER_ONLY_PATHS.has(path)) {
    violations.push(`${path}: manager-only route must not appear in ChatGPT OpenAPI`);
  }

  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (!operation?.operationId) continue;
    operationCount += 1;

    const description = operation.description;
    if (typeof description !== "string") continue;

    if (description.length > MAX_OPERATION_DESCRIPTION_LENGTH) {
      violations.push(
        `${method.toUpperCase()} ${path} (${operation.operationId}): ${description.length} chars (max ${MAX_OPERATION_DESCRIPTION_LENGTH})`
      );
    }
  }
}

if (operationCount > MAX_OPERATIONS) {
  violations.push(`OpenAPI has ${operationCount} operations (max ${MAX_OPERATIONS})`);
}

if (violations.length > 0) {
  console.error("OpenAPI GPT Actions constraints violated:\n");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  `OpenAPI OK: ${operationCount}/${MAX_OPERATIONS} operations; descriptions <= ${MAX_OPERATION_DESCRIPTION_LENGTH} chars; manager-only routes excluded`
);
