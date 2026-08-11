import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { log } from "../middleware/logging";
import {
  bumpOccurrence,
  createSuggestion,
  findOpenByDedupeKey,
  getSuggestion,
  listSuggestions,
  serializeSuggestion,
  updateSuggestion,
} from "../db/repositories/suggestions";

export const suggestionRoutes = new Hono<{
  Variables: { requestId: string };
}>();

const suggestionType = z.enum([
  "bug",
  "feature",
  "improvement",
  "api_design",
  "data_quality",
  "performance",
]);

const suggestionStatus = z.enum([
  "open",
  "planned",
  "in_progress",
  "resolved",
  "wont_fix",
]);

const suggestionSeverity = z.enum(["low", "medium", "high", "critical"]);

const createSchema = z.object({
  type: suggestionType,
  title: z.string().min(1).max(300),
  summary: z.string().max(4000).optional(),
  severity: suggestionSeverity.optional().default("medium"),
  component: z.string().max(100).optional(),
  observed_behavior: z.unknown().optional(),
  expected_behavior: z.string().max(4000).optional(),
  suggested_fix: z.string().max(4000).optional(),
  context: z.unknown().optional(),
  dedupe_key: z.string().min(1).max(200).optional(),
  request_id: z.string().max(100).optional(),
});

const patchSchema = z.object({
  status: suggestionStatus.optional(),
  severity: suggestionSeverity.optional(),
  title: z.string().min(1).max(300).optional(),
  summary: z.string().max(4000).optional(),
  component: z.string().max(100).optional(),
  expected_behavior: z.string().max(4000).optional(),
  suggested_fix: z.string().max(4000).optional(),
  observed_behavior: z.unknown().optional(),
  context: z.unknown().optional(),
});

suggestionRoutes.post("/api-suggestions", async (c) => {
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const data = parsed.data;
  const requestId =
    data.request_id ??
    c.req.header("x-request-id") ??
    c.get("requestId");

  if (data.dedupe_key) {
    const existing = findOpenByDedupeKey(data.dedupe_key);
    if (existing) {
      const bumped = bumpOccurrence(existing.id, {
        requestId,
        context: data.context,
        observedBehavior: data.observed_behavior,
      });

      log("info", "api_suggestion_deduped", {
        id: bumped.id,
        dedupe_key: data.dedupe_key,
        occurrences: bumped.occurrences,
      });

      return c.json(
        {
          ...serializeSuggestion(bumped),
          deduplicated: true,
        },
        200
      );
    }
  }

  const created = createSuggestion({
    type: data.type,
    title: data.title,
    summary: data.summary,
    severity: data.severity,
    component: data.component,
    observedBehavior: data.observed_behavior,
    expectedBehavior: data.expected_behavior,
    suggestedFix: data.suggested_fix,
    context: data.context,
    dedupeKey: data.dedupe_key,
    requestId,
  });

  log("info", "api_suggestion_created", {
    id: created.id,
    type: created.type,
    component: created.component,
    severity: created.severity,
    dedupe_key: created.dedupe_key,
    request_id: created.request_id,
  });

  return c.json(serializeSuggestion(created), 201);
});

suggestionRoutes.get("/api-suggestions", async (c) => {
  const status = c.req.query("status");
  const type = c.req.query("type");
  const component = c.req.query("component");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  if (status) {
    const ok = suggestionStatus.safeParse(status);
    if (!ok.success) {
      throw new AppError("VALIDATION_ERROR", `Invalid status: ${status}`, 400);
    }
  }
  if (type) {
    const ok = suggestionType.safeParse(type);
    if (!ok.success) {
      throw new AppError("VALIDATION_ERROR", `Invalid type: ${type}`, 400);
    }
  }

  const rows = listSuggestions({
    status,
    type,
    component,
    limit: Math.min(Math.max(limit, 1), 200),
  });

  return c.json({
    suggestions: rows.map(serializeSuggestion),
    count: rows.length,
  });
});

suggestionRoutes.get("/api-suggestions/:id", async (c) => {
  const row = getSuggestion(c.req.param("id"));
  if (!row) {
    throw new AppError("NOT_FOUND", "Suggestion not found", 404);
  }
  return c.json(serializeSuggestion(row));
});

suggestionRoutes.patch("/api-suggestions/:id", async (c) => {
  const body = await c.req.json();
  const parsed = patchSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new AppError("VALIDATION_ERROR", "No fields to update", 400);
  }

  const updated = updateSuggestion(c.req.param("id"), {
    status: parsed.data.status,
    severity: parsed.data.severity,
    title: parsed.data.title,
    summary: parsed.data.summary,
    component: parsed.data.component,
    expectedBehavior: parsed.data.expected_behavior,
    suggestedFix: parsed.data.suggested_fix,
    observedBehavior: parsed.data.observed_behavior,
    context: parsed.data.context,
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", "Suggestion not found", 404);
  }

  log("info", "api_suggestion_updated", {
    id: updated.id,
    status: updated.status,
  });

  return c.json(serializeSuggestion(updated));
});
