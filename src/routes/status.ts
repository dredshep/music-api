import { Hono } from "hono";
import * as slskd from "../services/slskd";
import * as navidrome from "../services/navidrome";
import * as musicbrainz from "../services/musicbrainz";
import * as lastfm from "../services/lastfm";
import * as listenbrainz from "../services/listenbrainz";
import { getLibraryScanStatus } from "../services/scan-status";

export const statusRoutes = new Hono();

statusRoutes.get("/status", async (c) => {
  const [slskdAvailable, navidromeAvailable, mbAvailable, lastfmAvailable, lbAvailable] =
    await Promise.all([
      slskd.ping(),
      navidrome.ping(),
      musicbrainz.ping(),
      lastfm.ping(),
      listenbrainz.isConfigured() ? listenbrainz.ping() : Promise.resolve(false),
    ]);

  const coreAvailable = slskdAvailable && navidromeAvailable && mbAvailable;
  const noneAvailable = !slskdAvailable && !navidromeAvailable && !mbAvailable;

  let overallStatus: "ok" | "degraded" | "unavailable";
  if (coreAvailable && lastfmAvailable) overallStatus = "ok";
  else if (noneAvailable) overallStatus = "unavailable";
  else overallStatus = "degraded";

  let scanStatus: Awaited<ReturnType<typeof getLibraryScanStatus>> | null = null;
  if (navidromeAvailable) {
    try {
      scanStatus = await getLibraryScanStatus();
    } catch {
      scanStatus = null;
    }
  }

  return c.json({
    status: overallStatus,
    services: {
      slskd: {
        available: slskdAvailable,
        ...(slskdAvailable ? {} : { error: "connection_failed" }),
      },
      navidrome: {
        available: navidromeAvailable,
        ...(navidromeAvailable ? {} : { error: "connection_failed" }),
        ...(scanStatus ? { scan: scanStatus } : {}),
      },
      musicbrainz: {
        available: mbAvailable,
        ...(mbAvailable ? {} : { error: "connection_failed" }),
      },
      lastfm: {
        configured: true,
        available: lastfmAvailable,
        ...(lastfmAvailable ? {} : { error: "connection_failed" }),
      },
      listenbrainz: {
        configured: listenbrainz.isConfigured(),
        available: lbAvailable,
        ...(!listenbrainz.isConfigured()
          ? { note: "not_configured" }
          : lbAvailable
            ? {}
            : { error: "connection_failed" }),
      },
    },
  });
});
