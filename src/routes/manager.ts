/**
 * Manager API — richer endpoints for the Music Manager web frontend.
 *
 * All routes under /manager/v1/. These are NOT included in the agent
 * OpenAPI spec and have no 30-operation budget restriction.
 */

import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { getConfig } from "../config";
import * as slskd from "../services/slskd";
import * as slskdDb from "../services/slskd-db";
import {
  getSearch,
  touchSearchUsage,
} from "../db/repositories/searches";
import { getVariantsForSearch } from "../db/repositories/search-variants";
import { getOrCreateSemanticSearch } from "../services/search-service";

export const managerRoutes = new Hono();

// --- Raw slskd searches ---

managerRoutes.get("/soulseek/searches", async (c) => {
  try {
    const searches = await slskd.listSearches();
    return c.json({ searches });
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to list searches",
      502,
      true
    );
  }
});

managerRoutes.get("/soulseek/searches/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const search = await slskd.getSearch(id);
    return c.json(search);
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to get search",
      502,
      true
    );
  }
});

managerRoutes.get("/soulseek/searches/:id/responses", async (c) => {
  const id = c.req.param("id");
  try {
    const responses = await slskd.getSearchResponses(id);
    return c.json({ responses });
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to get search responses",
      502,
      true
    );
  }
});

// --- Durable semantic searches ---

managerRoutes.post("/soulseek/semantic-searches/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const search = getSearch(id);
  if (!search) {
    throw new AppError("SEARCH_NOT_FOUND", "Semantic search not found", 404);
  }

  touchSearchUsage(search.id);
  const variants = getVariantsForSearch(search.id);
  const slskdIds = variants.length > 0
    ? variants.filter((v) => !v.missing_at).map((v) => v.slskd_search_id)
    : search.slskd_search_ids_json
      ? JSON.parse(search.slskd_search_ids_json)
      : [];

  if (slskdIds.length === 0) {
    return c.json({ search_id: id, response_count: 0, refreshed: false });
  }

  const { responses, diagnostics } = await slskd.refreshSearchResults(slskdIds, {
    waitMs: 15000,
  });

  return c.json({
    search_id: id,
    response_count: responses.length,
    diagnostics,
    refreshed: true,
  });
});

managerRoutes.post("/soulseek/semantic-searches/:id/research", async (c) => {
  const id = c.req.param("id");
  const search = getSearch(id);
  if (!search) {
    throw new AppError("SEARCH_NOT_FOUND", "Semantic search not found", 404);
  }

  const opts = search.search_options_json
    ? JSON.parse(search.search_options_json)
    : {};

  const result = await getOrCreateSemanticSearch({
    artist: search.artist,
    title: search.title,
    releaseType: search.release_type ?? "album",
    preferredFormats: opts.preferred_formats ?? ["FLAC", "MP3"],
    preferLrc: opts.prefer_lrc ?? true,
    maxCandidates: opts.max_candidates ?? 10,
    forceNew: true,
  });

  return c.json({
    search_id: result.searchRecord.id,
    previous_search_id: id,
    created: result.createdCount,
    adopted: result.adoptedCount,
  });
});

// --- Soulseek Transfers ---

managerRoutes.get("/soulseek/transfers/downloads", async (c) => {
  try {
    const downloads = await slskd.getDownloads();
    return c.json({ downloads });
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to get downloads",
      502,
      true
    );
  }
});

managerRoutes.get("/soulseek/transfers/uploads", async (c) => {
  try {
    const uploads = await slskdFetchUploads();
    return c.json({ uploads });
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to get uploads",
      502,
      true
    );
  }
});

const cancelTransferSchema = z.object({
  username: z.string().min(1),
  id: z.string().min(1),
  direction: z.enum(["downloads", "uploads"]),
});

managerRoutes.post("/soulseek/transfers/cancel", async (c) => {
  const body = await c.req.json();
  const parsed = cancelTransferSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { username, id, direction } = parsed.data;
  await slskdCancelTransfer(username, id, direction);
  return c.json({ ok: true });
});

// --- Soulseek Users ---

managerRoutes.get("/soulseek/users/:username/info", async (c) => {
  const username = c.req.param("username");
  try {
    const [info, status, browse] = await Promise.all([
      slskdFetchUserEndpoint(username, "info").catch(() => ({})),
      slskdFetchUserEndpoint(username, "status").catch(() => ({})),
      slskdFetchUserEndpoint(username, "browse", 45000).catch(() => ({})),
    ]);
    return c.json({ info, status, browse });
  } catch (err) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      err instanceof Error ? err.message : "Failed to get user info",
      502,
      true
    );
  }
});

// --- Soulseek History (from transfers.db) ---

const historySchema = z.object({
  direction: z.enum(["Download", "Upload"]).optional(),
  limit: z.coerce.number().min(1).max(2000).optional(),
  username: z.string().optional(),
  search: z.string().optional(),
});

managerRoutes.get("/soulseek/history", async (c) => {
  const query = historySchema.safeParse({
    direction: c.req.query("direction"),
    limit: c.req.query("limit"),
    username: c.req.query("username"),
    search: c.req.query("search"),
  });

  if (!query.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      query.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const transfers = slskdDb.transferHistory(query.data);
  return c.json({ transfers });
});

managerRoutes.get("/soulseek/stats", async (c) => {
  const overview = slskdDb.soulseekOverview();
  const stats = slskdDb.soulseekStats();
  return c.json({
    available: overview !== null,
    overview,
    stats,
  });
});

managerRoutes.get("/soulseek/stats/breakdown/:direction", async (c) => {
  const direction = c.req.param("direction");
  if (direction !== "Upload" && direction !== "Download") {
    throw new AppError("VALIDATION_ERROR", "Direction must be Upload or Download", 400);
  }
  const breakdown = slskdDb.stateBreakdown(direction);
  return c.json({ breakdown });
});

// --- Soulseek Peers ---

managerRoutes.get("/soulseek/peers", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
  const peers = slskdDb.topPeers(limit);
  return c.json({ peers });
});

managerRoutes.get("/soulseek/peers/:username/analytics", async (c) => {
  const username = c.req.param("username");
  const analytics = slskdDb.peerAnalytics(username);
  if (!analytics) {
    return c.json({ available: false, analytics: null });
  }
  return c.json({ available: true, analytics });
});

// --- Soulseek Messages ---

managerRoutes.get("/soulseek/messages", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 300), 1), 1000);
  const messages = slskdDb.recentMessages(limit);
  return c.json({
    available: slskdDb.isMessagingDbAvailable(),
    messages,
  });
});

managerRoutes.get("/soulseek/messages/:username", async (c) => {
  const username = c.req.param("username");
  const messages = slskdDb.messagesForUser(username);
  return c.json({ messages });
});

// --- Internal slskd fetch helpers ---

async function slskdFetchUploads(): Promise<unknown[]> {
  const config = getConfig();
  const base = `${config.SLSKD_URL}/api/${config.SLSKD_API_VERSION}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.SLSKD_API_KEY) {
    headers["X-API-Key"] = config.SLSKD_API_KEY;
  }

  const res = await fetch(`${base}/transfers/uploads`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`slskd ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<unknown[]>;
}

async function slskdCancelTransfer(
  username: string,
  id: string,
  direction: string
): Promise<void> {
  const config = getConfig();
  const base = `${config.SLSKD_URL}/api/${config.SLSKD_API_VERSION}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.SLSKD_API_KEY) {
    headers["X-API-Key"] = config.SLSKD_API_KEY;
  }

  const res = await fetch(
    `${base}/transfers/${direction}/${encodeURIComponent(username)}/${encodeURIComponent(id)}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) {
    throw new AppError(
      "SLSKD_UNAVAILABLE",
      `slskd returned ${res.status}`,
      502,
      true
    );
  }
}

async function slskdFetchUserEndpoint(
  username: string,
  endpoint: string,
  timeoutMs = 15000
): Promise<Record<string, unknown>> {
  const config = getConfig();
  const base = `${config.SLSKD_URL}/api/${config.SLSKD_API_VERSION}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.SLSKD_API_KEY) {
    headers["X-API-Key"] = config.SLSKD_API_KEY;
  }

  const res = await fetch(
    `${base}/users/${encodeURIComponent(username)}/${endpoint}`,
    { headers, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) return {};
  return res.json() as Promise<Record<string, unknown>>;
}
