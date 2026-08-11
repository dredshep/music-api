import { Hono } from "hono";
import {
  getSuggestion,
  listSuggestions,
  type SuggestionRecord,
} from "../db/repositories/suggestions";

export const suggestionsUiRoute = new Hono();

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(kind: string, value: string): string {
  return `<span class="b b-${kind}-${esc(value)}">${esc(value)}</span>`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Amsterdam",
    });
  } catch {
    return iso;
  }
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #111; --fg: #e8e8e8; --muted: #999; --line: #2a2a2a; --card: #1a1a1a; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --fg: #111; --muted: #666; --line: #e0e0e0; --card: #fff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 920px; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
  h1 { font-size: 1.25rem; font-weight: 650; margin: 0 0 .75rem; }
  a { color: inherit; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 1rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1rem; }
  .filters a { text-decoration: none; border: 1px solid var(--line); padding: .2rem .55rem; border-radius: 999px; font-size: 12px; color: var(--muted); }
  .filters a.on { border-color: var(--fg); color: var(--fg); }
  .item { border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: .85rem 1rem; margin-bottom: .6rem; }
  .item:hover { border-color: #666; }
  .item h2 { font-size: .95rem; font-weight: 600; margin: 0 0 .35rem; }
  .item h2 a { text-decoration: none; }
  .row { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-bottom: .35rem; }
  .b { font-size: 11px; padding: .1rem .4rem; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); text-transform: lowercase; }
  .b-status-open, .b-severity-high, .b-severity-critical { border-color: #c44; color: #e88; }
  .b-status-resolved, .b-status-wont_fix { opacity: .7; }
  .b-status-planned, .b-status-in_progress { border-color: #a80; color: #da6; }
  .summary { color: var(--muted); font-size: 13px; margin: .25rem 0 0; white-space: pre-wrap; }
  .back { display: inline-block; margin-bottom: 1rem; color: var(--muted); font-size: 13px; }
  .section { margin-top: 1.1rem; }
  .section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 .35rem; }
  .section p, .section pre { margin: 0; white-space: pre-wrap; font-size: 13.5px; }
  .section pre { font-family: ui-monospace, monospace; background: var(--bg); border: 1px solid var(--line); padding: .75rem; border-radius: 6px; overflow-x: auto; }
  .empty { color: var(--muted); padding: 2rem 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function listPage(items: SuggestionRecord[], statusFilter: string | null): string {
  const statuses = ["open", "planned", "in_progress", "resolved", "wont_fix", "all"];
  const filters = statuses
    .map((s) => {
      const href = s === "all" ? "/suggestions" : `/suggestions?status=${s}`;
      const on = (statusFilter ?? "open") === s || (s === "all" && statusFilter === "all");
      return `<a href="${href}" class="${on ? "on" : ""}">${s}</a>`;
    })
    .join("");

  const rows =
    items.length === 0
      ? `<p class="empty">No suggestions.</p>`
      : items
          .map(
            (s) => `
    <article class="item">
      <div class="row">
        ${badge("status", s.status)}
        ${badge("severity", s.severity)}
        ${badge("type", s.type)}
        ${s.occurrences > 1 ? `<span class="b">×${s.occurrences}</span>` : ""}
      </div>
      <h2><a href="/suggestions/${esc(s.id)}">${esc(s.title)}</a></h2>
      <div class="meta">${esc(s.component ?? "—")} · ${fmtDate(s.created_at)}</div>
      ${s.summary ? `<p class="summary">${esc(s.summary.slice(0, 280))}${s.summary.length > 280 ? "…" : ""}</p>` : ""}
    </article>`
          )
          .join("");

  return layout(
    "API Suggestions",
    `<h1>API Suggestions</h1>
     <p class="meta">${items.length} shown</p>
     <div class="filters">${filters}</div>
     ${rows}`
  );
}

function detailPage(s: SuggestionRecord): string {
  const parseJson = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  const observed = parseJson(s.observed_behavior_json);
  const context = parseJson(s.context_json);

  return layout(
    s.title,
    `<a class="back" href="/suggestions">← all</a>
     <div class="row">
       ${badge("status", s.status)}
       ${badge("severity", s.severity)}
       ${badge("type", s.type)}
       ${s.occurrences > 1 ? `<span class="b">×${s.occurrences}</span>` : ""}
     </div>
     <h1>${esc(s.title)}</h1>
     <p class="meta">${esc(s.component ?? "—")} · ${esc(s.id)} · ${fmtDate(s.created_at)}</p>
     ${s.summary ? `<div class="section"><h3>Summary</h3><p>${esc(s.summary)}</p></div>` : ""}
     ${s.expected_behavior ? `<div class="section"><h3>Expected</h3><p>${esc(s.expected_behavior)}</p></div>` : ""}
     ${s.suggested_fix ? `<div class="section"><h3>Suggested fix</h3><p>${esc(s.suggested_fix)}</p></div>` : ""}
     ${observed ? `<div class="section"><h3>Observed</h3><pre>${esc(observed)}</pre></div>` : ""}
     ${context ? `<div class="section"><h3>Context</h3><pre>${esc(context)}</pre></div>` : ""}
     <div class="section"><h3>Meta</h3><p class="summary">dedupe: ${esc(s.dedupe_key ?? "—")}<br>request: ${esc(s.request_id ?? "—")}<br>updated: ${fmtDate(s.updated_at)}<br>last seen: ${fmtDate(s.last_seen_at)}</p></div>`
  );
}

suggestionsUiRoute.get("/suggestions", (c) => {
  const statusParam = c.req.query("status");
  const status =
    statusParam === "all"
      ? undefined
      : statusParam && ["open", "planned", "in_progress", "resolved", "wont_fix"].includes(statusParam)
        ? (statusParam as "open" | "planned" | "in_progress" | "resolved" | "wont_fix")
        : "open";

  const items = listSuggestions({
    status,
    limit: 200,
  });

  return c.html(listPage(items, statusParam ?? "open"));
});

suggestionsUiRoute.get("/suggestions/:id", (c) => {
  const s = getSuggestion(c.req.param("id"));
  if (!s) return c.html(layout("Not found", `<a class="back" href="/suggestions">← all</a><p class="empty">Not found.</p>`), 404);
  return c.html(detailPage(s));
});
