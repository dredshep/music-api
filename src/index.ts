import { Hono } from "hono";
import { loadConfig } from "./config";
import { authMiddleware } from "./middleware/auth";
import { errorHandler, formatErrorResponse } from "./middleware/errors";
import { loggingMiddleware, type AppVariables } from "./middleware/logging";
import { statusRoutes } from "./routes/status";
import { libraryRoutes } from "./routes/library";
import { catalogRoutes } from "./routes/catalog";
import { searchRoutes } from "./routes/search";
import { downloadRoutes } from "./routes/downloads";
import { suggestionRoutes } from "./routes/suggestions";
import { recommendationRoutes } from "./routes/recommendations";
import { openapiRoute } from "./routes/openapi";
import { initDatabase } from "./db/database";
import { startCleanupTimer } from "./db/cleanup";

const config = loadConfig();

initDatabase();

const app = new Hono<{ Variables: AppVariables }>();

app.onError((err, c) => {
  const { status, body } = formatErrorResponse(err);
  return c.json(body, status as 400);
});

app.use("*", loggingMiddleware());
app.use("*", errorHandler());

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/", openapiRoute);

app.use("/v1/*", authMiddleware());
app.route("/v1", statusRoutes);
app.route("/v1", libraryRoutes);
app.route("/v1", catalogRoutes);
app.route("/v1", searchRoutes);
app.route("/v1", downloadRoutes);
app.route("/v1", suggestionRoutes);
app.route("/v1", recommendationRoutes);

startCleanupTimer();

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
