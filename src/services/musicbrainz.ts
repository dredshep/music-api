import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";
import { getCache, setCache } from "../db/repositories/cache";
import type {
  MBArtist,
  MBArtistSearchResult,
  MBReleaseGroup,
  MBReleaseGroupBrowseResult,
} from "../types/upstream";

// Process-wide rate limiter: max 1 request/second
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100;

const RETRY_DELAY_MS = 3000;
const ABORT_TIMEOUT_MS = 15000;
const TRANSIENT_HTTP = new Set([500, 502, 503, 504]);

// In-flight request deduplication
const inflightRequests = new Map<string, Promise<unknown>>();

/** Exported for tests to assert cleanup. */
export function getInflightCount(): number {
  return inflightRequests.size;
}

function isTransientError(err: unknown): boolean {
  if (err instanceof AppError) return false;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof TypeError) return true; // fetch network errors
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("certificate") || msg.includes("tls") || msg.includes("ssl")) return true;
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("etimedout")) return true;
    if (msg.includes("fetch failed") || msg.includes("unable to connect")) return true;
  }
  return false;
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) return RETRY_DELAY_MS;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 1) return RETRY_DELAY_MS;
  return Math.min(Math.max(seconds, 1), 60) * 1000;
}

async function singleAttempt(url: string, userAgent: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function rateLimitedFetch<T>(
  url: string,
  cacheKey?: string,
  cacheTtlMs?: number
): Promise<T> {
  if (cacheKey) {
    const cached = getCache<T>(cacheKey);
    if (cached !== null) return cached;
  }

  const dedupeKey = url;
  const inflight = inflightRequests.get(dedupeKey);
  if (inflight) return inflight as Promise<T>;

  const doRequest = async (): Promise<T> => {
    const config = getConfig();
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
      }
      lastRequestTime = Date.now();

      let res: Response;
      try {
        res = await singleAttempt(url, config.MUSICBRAINZ_USER_AGENT);
      } catch (err) {
        lastError = err;
        if (attempt === 0 && isTransientError(err)) {
          log("warn", "musicbrainz_network_retry", {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        break;
      }

      if (res.status === 429) {
        const retryMs = parseRetryAfterMs(res.headers.get("Retry-After"));
        throw new AppError(
          "MUSICBRAINZ_RATE_LIMITED",
          "MusicBrainz rate limit exceeded",
          503,
          true,
          undefined,
          retryMs
        );
      }

      if (TRANSIENT_HTTP.has(res.status)) {
        lastError = new Error(`MusicBrainz returned HTTP ${res.status}`);
        if (attempt === 0) {
          log("warn", "musicbrainz_http_retry", { url, status: res.status });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        break;
      }

      if (!res.ok) {
        throw new AppError(
          "MUSICBRAINZ_UNAVAILABLE",
          `MusicBrainz returned ${res.status}`,
          503,
          true,
          undefined,
          RETRY_DELAY_MS
        );
      }

      let data: T;
      try {
        data = (await res.json()) as T;
      } catch (jsonErr) {
        lastError = jsonErr;
        if (attempt === 0) {
          log("warn", "musicbrainz_json_retry", {
            url,
            error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
          });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        break;
      }

      if (cacheKey && cacheTtlMs) setCache(cacheKey, data, cacheTtlMs);
      return data;
    }

    const rawMessage =
      lastError instanceof Error ? lastError.message : "MusicBrainz connection failed";
    log("error", "musicbrainz_exhausted", { url, error: rawMessage });
    throw new AppError(
      "MUSICBRAINZ_UNAVAILABLE",
      rawMessage,
      503,
      true,
      undefined,
      RETRY_DELAY_MS
    );
  };

  const promise = doRequest();
  inflightRequests.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(dedupeKey);
  }
}

export async function ping(): Promise<boolean> {
  try {
    const config = getConfig();
    const url = `${config.MUSICBRAINZ_URL}/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json`;
    await rateLimitedFetch<unknown>(url);
    return true;
  } catch {
    return false;
  }
}

export interface MBArtistResult {
  id: string;
  name: string;
  sortName: string;
  disambiguation?: string;
  type?: string;
  country?: string;
  aliases: { name: string; type?: string; locale?: string; primary?: boolean }[];
}

export async function searchArtist(
  query: string,
  limit = 10
): Promise<MBArtistResult[]> {
  const config = getConfig();
  const url = `${config.MUSICBRAINZ_URL}/artist?query=${encodeURIComponent(query)}&limit=${limit}&fmt=json`;
  const cacheKey = `mb:artist_search:${query.toLowerCase()}`;
  const cacheTtl = config.ARTIST_CACHE_DAYS * 24 * 60 * 60 * 1000;

  const result = await rateLimitedFetch<MBArtistSearchResult>(
    url,
    cacheKey,
    cacheTtl
  );

  return (result.artists ?? []).map(mapArtist);
}

export async function getArtist(mbid: string): Promise<MBArtistResult> {
  const config = getConfig();
  const url = `${config.MUSICBRAINZ_URL}/artist/${mbid}?inc=aliases&fmt=json`;
  const cacheKey = `mb:artist:${mbid}`;
  const cacheTtl = config.ARTIST_CACHE_DAYS * 24 * 60 * 60 * 1000;

  const result = await rateLimitedFetch<MBArtist>(url, cacheKey, cacheTtl);
  return mapArtist(result);
}

export async function getArtistAliases(
  mbid: string
): Promise<{ name: string; type?: string; locale?: string; primary?: boolean }[]> {
  const artist = await getArtist(mbid);
  return artist.aliases;
}

export interface MBRecordingResult {
  id: string;
  title: string;
  artistCredit: string;
  score: number;
  firstReleaseDate?: string;
}

type MBRecordingSearchResponse = {
  recordings?: Array<{
    id: string;
    title: string;
    score?: number;
    "first-release-date"?: string;
    "artist-credit"?: Array<{
      name?: string;
      joinphrase?: string;
      artist?: { name?: string };
    }>;
  }>;
};

/** Cached recording search used as an independent Radio candidate source. */
export async function searchRecordings(query: string, limit = 25): Promise<MBRecordingResult[]> {
  const config = getConfig();
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const url = `${config.MUSICBRAINZ_URL}/recording?query=${encodeURIComponent(query)}&limit=${bounded}&fmt=json`;
  const cacheKey = `mb:recording_search:${query.toLowerCase()}:${bounded}`;
  const cacheTtl = config.CATALOG_CACHE_HOURS * 60 * 60 * 1000;
  const result = await rateLimitedFetch<MBRecordingSearchResponse>(url, cacheKey, cacheTtl);
  return (result.recordings ?? []).map((recording) => ({
    id: recording.id,
    title: recording.title,
    score: Math.max(0, Math.min(100, recording.score ?? 0)),
    firstReleaseDate: recording["first-release-date"],
    artistCredit: (recording["artist-credit"] ?? [])
      .map((credit) => `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`)
      .join("")
      .trim(),
  })).filter((recording) => recording.title && recording.artistCredit);
}

export interface MBReleaseGroupResult {
  id: string;
  title: string;
  primaryType?: string;
  secondaryTypes: string[];
  firstReleaseDate?: string;
  artistCredit?: string;
}

export async function browseReleaseGroups(
  artistMbid: string,
  params?: { limit?: number; offset?: number; type?: string }
): Promise<{ releaseGroups: MBReleaseGroupResult[]; totalCount: number }> {
  const config = getConfig();
  const limit = params?.limit ?? 100;
  const offset = params?.offset ?? 0;

  let url = `${config.MUSICBRAINZ_URL}/release-group?artist=${artistMbid}&limit=${limit}&offset=${offset}&fmt=json`;
  if (params?.type) {
    url += `&type=${encodeURIComponent(params.type)}`;
  }

  const cacheKey = `mb:rg:${artistMbid}:${limit}:${offset}:${params?.type ?? "all"}`;
  const cacheTtl = config.CATALOG_CACHE_HOURS * 60 * 60 * 1000;

  const result = await rateLimitedFetch<MBReleaseGroupBrowseResult>(
    url,
    cacheKey,
    cacheTtl
  );

  return {
    releaseGroups: (result["release-groups"] ?? []).map(mapReleaseGroup),
    totalCount: result["release-group-count"] ?? 0,
  };
}

export async function getAllReleaseGroups(
  artistMbid: string
): Promise<MBReleaseGroupResult[]> {
  const allGroups: MBReleaseGroupResult[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { releaseGroups, totalCount } = await browseReleaseGroups(
      artistMbid,
      { limit, offset }
    );
    allGroups.push(...releaseGroups);

    if (allGroups.length >= totalCount || releaseGroups.length === 0) break;
    offset += limit;
  }

  return allGroups;
}

function mapArtist(a: MBArtist): MBArtistResult {
  return {
    id: a.id,
    name: a.name,
    sortName: a["sort-name"],
    disambiguation: a.disambiguation,
    type: a.type,
    country: a.country,
    aliases: (a.aliases ?? []).map((al) => ({
      name: al.name,
      type: al.type,
      locale: al.locale,
      primary: al.primary,
    })),
  };
}

function mapReleaseGroup(rg: MBReleaseGroup): MBReleaseGroupResult {
  const artistCredit = rg["artist-credit"]
    ?.map((c) => `${c.artist.name}${c.joinphrase ?? ""}`)
    .join("");

  return {
    id: rg.id,
    title: rg.title,
    primaryType: rg["primary-type"],
    secondaryTypes: rg["secondary-types"] ?? [],
    firstReleaseDate: rg["first-release-date"],
    artistCredit,
  };
}