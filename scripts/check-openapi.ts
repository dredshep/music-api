import { getOpenApiSpec } from "../src/routes/openapi";

const MAX_OPERATION_DESCRIPTION_LENGTH = 300;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

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
        `${method.toUpperCase()} ${path} (${operation.operationId}): ${description.length} chars (max ${MAX_OPERATION_DESCRIPTION_LENGTH})`
      );
    }
  }
}

if (violations.length > 0) {
  console.error("OpenAPI operation descriptions exceed limit:\n");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  `OpenAPI OK: all operation descriptions <= ${MAX_OPERATION_DESCRIPTION_LENGTH} chars`
);
