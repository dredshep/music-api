import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { loadConfig } from "./config";
import { authMiddleware, managerAuthMiddleware } from "./middleware/auth";
import { errorHandler, formatErrorResponse } from "./middleware/errors";
import { loggingMiddleware, type AppVariables } from "./middleware/logging";
import { failBanMiddleware, publicRateLimit, authenticatedRateLimit } from "./middleware/rate-limit";
import { statusRoutes } from "./routes/status";
import { libraryRoutes } from "./routes/library";
import { libraryOwnershipRoutes } from "./routes/library-ownership";
import { catalogRoutes } from "./routes/catalog";
import { searchRoutes } from "./routes/search";
import { downloadRoutes } from "./routes/downloads";
import { downloadFileControlRoutes } from "./routes/download-file-controls";
import { acquisitionRoutes } from "./routes/acquisitions";
import { suggestionRoutes } from "./routes/suggestions";
import { suggestionsUiRoute } from "./routes/suggestions-ui";
import { recommendationRoutes } from "./routes/recommendations";
import { lyricsRoutes } from "./routes/lyrics";
import { playerRoutes } from "./routes/player";
import { openapiRoute } from "./routes/openapi";
import { openapiManagerRoute } from "./routes/openapi-manager";
import { managerRoutes } from "./routes/manager";
import { initDatabase } from "./db/database";
import { startCleanupTimer } from "./db/cleanup";
import { warmLibraryDiskUsageCache } from "./services/library-storage";
import { startReconciler } from "./services/download-reconciler";

const config = loadConfig();

initDatabase();

const app = new Hono<{ Variables: AppVariables }>();

app.onError((err, c) => {
  const { status, body, retryAfterSeconds } = formatErrorResponse(err);
  if (retryAfterSeconds != null) {
    c.header("Retry-After", String(retryAfterSeconds));
  }
  return c.json(body, status as 400);
});

// 1. IP flood/ban check (cheapest possible, before anything else)
app.use("*", failBanMiddleware());

// 2. Body size limit — reject oversized payloads before parsing
app.use("*", bodyLimit({
  maxSize: 128 * 1024,
  onError: (c) => {
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 128KB limit", retryable: false } }, 413);
  },
}));

// 3. Error handler wrapper
app.use("*", errorHandler());

// --- Public routes (no auth, modest rate limit) ---
app.use("/health", publicRateLimit());
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/", openapiRoute);
app.route("/", openapiManagerRoute);
app.route("/", suggestionsUiRoute);

// --- Authenticated routes ---
// Auth runs BEFORE the body-aware logger so invalid tokens are rejected cheaply
app.use("/v1/*", authMiddleware());
app.use("/v1/*", authenticatedRateLimit());
app.use("/v1/*", loggingMiddleware());

app.route("/v1", statusRoutes);
app.route("/v1", libraryRoutes);
app.route("/v1", libraryOwnershipRoutes);
app.route("/v1", catalogRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", downloadRoutes);
app.route("/v1", downloadFileControlRoutes);
app.route("/v1", acquisitionRoutes);
app.route("/v1", suggestionRoutes);
app.route("/v1", recommendationRoutes);
app.route("/v1", lyricsRoutes);
app.route("/v1", playerRoutes);

// --- Manager API (separate auth, broader surface) ---
app.use("/manager/v1/*", managerAuthMiddleware());
app.use("/manager/v1/*", authenticatedRateLimit());
app.use("/manager/v1/*", loggingMiddleware());
app.route("/manager/v1", managerRoutes);

startCleanupTimer();
startReconciler();
warmLibraryDiskUsageCache();

console.log(
  JSON.stringify({
    level: "info",
    event: "server_started",
    port: config.PORT,
    timestamp: new Date().toISOString(),
  })
);

export default {
  port: config.PORT,
  fetch: app.fetch,
};
