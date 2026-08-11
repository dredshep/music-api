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

// In-flight request deduplication
const inflightRequests = new Map<string, Promise<unknown>>();

async function rateLimitedFetch<T>(
  url: string,
  cacheKey?: string,
  cacheTtlMs?: number
): Promise<T> {
  // Check cache first
  if (cacheKey) {
    const cached = getCache<T>(cacheKey);
    if (cached !== null) return cached;
  }

  // Deduplicate identical in-flight requests
  const dedupeKey = url;
  const inflight = inflightRequests.get(dedupeKey);
  if (inflight) return inflight as Promise<T>;

  const doRequest = async (): Promise<T> => {
    // Rate limit
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastRequestTime = Date.now();

    const config = getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": config.MUSICBRAINZ_USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (res.status === 503) {
        // Retry once with backoff
        log("warn", "musicbrainz_503_retry", { url });
        await new Promise((r) => setTimeout(r, 3000));
        lastRequestTime = Date.now();

        const retryRes = await fetch(url, {
          headers: {
            "User-Agent": config.MUSICBRAINZ_USER_AGENT,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!retryRes.ok) {
          throw new AppError(
            "MUSICBRAINZ_UNAVAILABLE",
            `MusicBrainz returned ${retryRes.status} after retry`,
            502,
            true
          );
        }

        const data = (await retryRes.json()) as T;
        if (cacheKey && cacheTtlMs) setCache(cacheKey, data, cacheTtlMs);
        return data;
      }

      if (res.status === 429) {
        throw new AppError(
          "MUSICBRAINZ_RATE_LIMITED",
          "MusicBrainz rate limit exceeded",
          429,
          true
        );
      }

      if (!res.ok) {
        throw new AppError(
          "MUSICBRAINZ_UNAVAILABLE",
          `MusicBrainz returned ${res.status}`,
          502,
          true
        );
      }

      const data = (await res.json()) as T;
      if (cacheKey && cacheTtlMs) setCache(cacheKey, data, cacheTtlMs);
      return data;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message =
        err instanceof Error ? err.message : "MusicBrainz connection failed";
      throw new AppError("MUSICBRAINZ_UNAVAILABLE", message, 502, true);
    } finally {
      clearTimeout(timeout);
      inflightRequests.delete(dedupeKey);
    }
  };

  const promise = doRequest();
  inflightRequests.set(dedupeKey, promise);
  return promise;
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
