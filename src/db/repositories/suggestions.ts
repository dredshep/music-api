import { getDb } from "../database";
import { ulid } from "ulid";

export type SuggestionType =
  | "bug"
  | "feature"
  | "improvement"
  | "api_design"
  | "data_quality"
  | "performance";

export type SuggestionStatus =
  | "open"
  | "planned"
  | "in_progress"
  | "resolved"
  | "wont_fix";

export type SuggestionSeverity = "low" | "medium" | "high" | "critical";

export interface SuggestionRecord {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  severity: string;
  component: string | null;
  status: string;
  observed_behavior_json: string | null;
  expected_behavior: string | null;
  suggested_fix: string | null;
  context_json: string | null;
  dedupe_key: string | null;
  request_id: string | null;
  occurrences: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface CreateSuggestionParams {
  type: SuggestionType;
  title: string;
  summary?: string;
  severity?: SuggestionSeverity;
  component?: string;
  observedBehavior?: unknown;
  expectedBehavior?: string;
  suggestedFix?: string;
  context?: unknown;
  dedupeKey?: string;
  requestId?: string;
}

export interface UpdateSuggestionParams {
  status?: SuggestionStatus;
  severity?: SuggestionSeverity;
  title?: string;
  summary?: string;
  component?: string;
  expectedBehavior?: string;
  suggestedFix?: string;
  observedBehavior?: unknown;
  context?: unknown;
}

export function serializeSuggestion(row: SuggestionRecord): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    component: row.component,
    status: row.status,
    observed_behavior: row.observed_behavior_json
      ? JSON.parse(row.observed_behavior_json)
      : null,
    expected_behavior: row.expected_behavior,
    suggested_fix: row.suggested_fix,
    context: row.context_json ? JSON.parse(row.context_json) : null,
    dedupe_key: row.dedupe_key,
    request_id: row.request_id,
    occurrences: row.occurrences,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
  };
}

export function findOpenByDedupeKey(dedupeKey: string): SuggestionRecord | null {
  const db = getDb();
  return (
    db
      .query<SuggestionRecord, [string]>(
        "SELECT * FROM api_suggestions WHERE dedupe_key = ? AND status = 'open' LIMIT 1"
      )
      .get(dedupeKey) ?? null
  );
}

export function bumpOccurrence(
  id: string,
  extras?: {
    requestId?: string;
    context?: unknown;
    observedBehavior?: unknown;
  }
): SuggestionRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getSuggestion(id);
  if (!existing) {
    throw new Error(`Suggestion ${id} not found`);
  }

  // Merge context evidence on repeat sightings
  let contextJson = existing.context_json;
  if (extras?.context !== undefined) {
    const prev = existing.context_json ? JSON.parse(existing.context_json) : {};
    const next =
      extras.context && typeof extras.context === "object" && !Array.isArray(extras.context)
        ? { ...(typeof prev === "object" && prev && !Array.isArray(prev) ? prev : {}), ...extras.context }
        : extras.context;
    contextJson = JSON.stringify(next);
  }

  let observedJson = existing.observed_behavior_json;
  if (extras?.observedBehavior !== undefined) {
    observedJson = JSON.stringify(extras.observedBehavior);
  }

  db.query(
    `UPDATE api_suggestions
     SET occurrences = occurrences + 1,
         last_seen_at = ?,
         updated_at = ?,
         request_id = COALESCE(?, request_id),
         context_json = ?,
         observed_behavior_json = ?
     WHERE id = ?`
  ).run(
    now,
    now,
    extras?.requestId ?? null,
    contextJson,
    observedJson,
    id
  );

  return getSuggestion(id)!;
}

export function createSuggestion(params: CreateSuggestionParams): SuggestionRecord {
  const db = getDb();
  const id = `api_${ulid()}`;
  const now = new Date().toISOString();

  const record: SuggestionRecord = {
    id,
    type: params.type,
    title: params.title,
    summary: params.summary ?? null,
    severity: params.severity ?? "medium",
    component: params.component ?? null,
    status: "open",
    observed_behavior_json:
      params.observedBehavior !== undefined
        ? JSON.stringify(params.observedBehavior)
        : null,
    expected_behavior: params.expectedBehavior ?? null,
    suggested_fix: params.suggestedFix ?? null,
    context_json:
      params.context !== undefined ? JSON.stringify(params.context) : null,
    dedupe_key: params.dedupeKey ?? null,
    request_id: params.requestId ?? null,
    occurrences: 1,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };

  db.query(
    `INSERT INTO api_suggestions (
      id, type, title, summary, severity, component, status,
      observed_behavior_json, expected_behavior, suggested_fix,
      context_json, dedupe_key, request_id, occurrences,
      created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.type,
    record.title,
    record.summary,
    record.severity,
    record.component,
    record.status,
    record.observed_behavior_json,
    record.expected_behavior,
    record.suggested_fix,
    record.context_json,
    record.dedupe_key,
    record.request_id,
    record.occurrences,
    record.created_at,
    record.updated_at,
    record.last_seen_at
  );

  return record;
}

export function getSuggestion(id: string): SuggestionRecord | null {
  const db = getDb();
  return (
    db
      .query<SuggestionRecord, [string]>(
        "SELECT * FROM api_suggestions WHERE id = ?"
      )
      .get(id) ?? null
  );
}

export function listSuggestions(filters: {
  status?: string;
  type?: string;
  component?: string;
  limit?: number;
}): SuggestionRecord[] {
  const db = getDb();
  const limit = filters.limit ?? 50;
  const clauses: string[] = [];
  const args: Array<string | number> = [];

  if (filters.status) {
    clauses.push("status = ?");
    args.push(filters.status);
  }
  if (filters.type) {
    clauses.push("type = ?");
    args.push(filters.type);
  }
  if (filters.component) {
    clauses.push("component = ?");
    args.push(filters.component);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(limit);

  return db
    .query<SuggestionRecord, Array<string | number>>(
      `SELECT * FROM api_suggestions ${where} ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...args);
}

export function updateSuggestion(
  id: string,
  params: UpdateSuggestionParams
): SuggestionRecord | null {
  const existing = getSuggestion(id);
  if (!existing) return null;

  const db = getDb();
  const now = new Date().toISOString();

  const next: SuggestionRecord = {
    ...existing,
    status: params.status ?? existing.status,
    severity: params.severity ?? existing.severity,
    title: params.title ?? existing.title,
    summary: params.summary !== undefined ? params.summary : existing.summary,
    component:
      params.component !== undefined ? params.component : existing.component,
    expected_behavior:
      params.expectedBehavior !== undefined
        ? params.expectedBehavior
        : existing.expected_behavior,
    suggested_fix:
      params.suggestedFix !== undefined
        ? params.suggestedFix
        : existing.suggested_fix,
    observed_behavior_json:
      params.observedBehavior !== undefined
        ? JSON.stringify(params.observedBehavior)
        : existing.observed_behavior_json,
    context_json:
      params.context !== undefined
        ? JSON.stringify(params.context)
        : existing.context_json,
    updated_at: now,
  };

  db.query(
    `UPDATE api_suggestions SET
      status = ?, severity = ?, title = ?, summary = ?, component = ?,
      expected_behavior = ?, suggested_fix = ?,
      observed_behavior_json = ?, context_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    next.status,
    next.severity,
    next.title,
    next.summary,
    next.component,
    next.expected_behavior,
    next.suggested_fix,
    next.observed_behavior_json,
    next.context_json,
    next.updated_at,
    id
  );

  return getSuggestion(id);
}
