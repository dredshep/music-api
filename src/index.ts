import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { loadConfig } from "./config";
import { authMiddleware, managerAuthMiddleware } from "./middleware/auth";
import { errorHandler, formatErrorResponse } from "./middleware/errors";
import { loggingMiddleware, type AppVariables } from "./middleware/logging";
import { failBanMiddleware, publicRateLimit, authenticatedRateLimit } from "./middleware/rate-limit";
import { statusRoutes } from "./routes/status";
import { libraryRoutes } from "./routes/library";
import { navidromeMatchRoutes } from "./routes/navidrome-matches";
import { catalogRoutes } from "./routes/catalog";
import { catalogIndexRoutes } from "./routes/catalog-index";
import { searchRoutes } from "./routes/search";
import { downloadRoutes } from "./routes/downloads";
import { downloadFileControlRoutes } from "./routes/download-file-controls";
import { acquisitionRoutes } from "./routes/acquisitions";
import { suggestionRoutes } from "./routes/suggestions";
import { suggestionsUiRoute } from "./routes/suggestions-ui";
import { recommendationRoutes } from "./routes/recommendations";
import { radioRoutes } from "./routes/radio";
import { radioSemanticRoutes } from "./routes/radio-semantic";
import { radioExternalRoutes } from "./routes/radio-external";
import { radioAnalysisRoutes } from "./routes/radio-analysis";
import { radioLiveManagerRoutes } from "./routes/radio-live-manager";
import { radioLiveSemanticRoutes } from "./routes/radio-live-semantic";
import { lyricsRoutes } from "./routes/lyrics";
import { playerRoutes } from "./routes/player";
import { openapiRoute } from "./routes/openapi";
import { openapiManagerRoute } from "./routes/openapi-manager";
import { openapiRadioRoute } from "./routes/openapi-radio";
import { openapiManagerRadioRoute } from "./routes/openapi-manager-radio";
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
  if (retryAfterSeconds != null) c.header("Retry-After", String(retryAfterSeconds));
  return c.json(body, status as 400);
});

app.use("*", failBanMiddleware());
app.use("*", bodyLimit({
  // Navidrome match refresh batches contain up to 500 track descriptors. Keep the
  // limit bounded while allowing even long-but-valid metadata fields.
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1MB limit", retryable: false } }, 413),
}));
app.use("*", errorHandler());

app.use("/health", publicRateLimit());
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/", openapiRoute);
app.route("/", openapiManagerRoute);
app.route("/", openapiRadioRoute);
app.route("/", openapiManagerRadioRoute);
app.route("/", suggestionsUiRoute);

app.use("/v1/*", authMiddleware());
app.use("/v1/*", authenticatedRateLimit());
app.use("/v1/*", loggingMiddleware());

app.route("/v1", statusRoutes);
app.route("/v1", libraryRoutes);
app.route("/v1", navidromeMatchRoutes);
app.route("/v1", catalogRoutes);
app.route("/v1", catalogIndexRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", downloadRoutes);
app.route("/v1", downloadFileControlRoutes);
app.route("/v1", acquisitionRoutes);
app.route("/v1", suggestionRoutes);
app.route("/v1", recommendationRoutes);
app.route("/v1", radioSemanticRoutes);
app.route("/v1", radioLiveSemanticRoutes);
app.route("/v1", lyricsRoutes);
app.route("/v1", playerRoutes);

app.use("/manager/v1/*", managerAuthMiddleware());
app.use("/manager/v1/*", authenticatedRateLimit());
app.use("/manager/v1/*", loggingMiddleware());
app.route("/manager/v1", managerRoutes);
app.route("/manager/v1", radioRoutes);
app.route("/manager/v1", radioExternalRoutes);
app.route("/manager/v1", radioAnalysisRoutes);
app.route("/manager/v1", radioLiveManagerRoutes);

startCleanupTimer();
startReconciler();
warmLibraryDiskUsageCache();

console.log(JSON.stringify({ level: "info", event: "server_started", port: config.PORT, timestamp: new Date().toISOString() }));

export default { port: config.PORT, fetch: app.fetch, idleTimeout: 120 };
