import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { log } from "../middleware/logging";
import { getConfig } from "../config";
import * as musicbrainz from "../services/musicbrainz";
import * as navidrome from "../services/navidrome";
import type { LibraryAlbum } from "../services/navidrome";
import {
  filterReleaseGroups,
  matchCatalogToLibrary,
  summarizeCatalogResults,
  type CatalogEntry,
} from "../domain/catalog";
import { artistMatch } from "../domain/normalization";
import { addAliases, clearAliasesForArtist } from "../db/repositories/aliases";
import {
  getCatalogArtist,
  listCatalogArtists,
  upsertCatalogArtist,
  markCatalogChecked,
  isCatalogStale,
  getReleaseGroupsForArtist,
  upsertReleaseGroups,
  deleteReleaseGroupsForArtist,
  getCatalogStats,
  type CatalogReleaseGroupRecord,
} from "../db/repositories/catalog";

export const catalogRoutes = new Hono();

const missingCatalogSchema = z.object({
  artist: z.string().min(1),
  musicbrainz_id: z.string().optional(),
  release_types: z
    .array(z.string())
    .optional()
    .default(["Album", "EP", "Single"]),
  include_compilations: z.boolean().optional().default(false),
  force_refresh: z.boolean().optional().default(false),
});

const libraryMissingSchema = z.object({
  release_types: z
    .array(z.string())
    .optional()
    .default(["Album"]),
  include_compilations: z.boolean().optional().default(false),
  min_missing: z.number().int().min(0).optional().default(1),
  limit_artists: z.number().int().min(1).max(500).optional().default(50),
  include_releases: z.boolean().optional().default(true),
  only_checked: z.boolean().optional().default(true),
});

catalogRoutes.post("/catalog/missing", async (c) => {
  const body = await c.req.json();
  const parsed = missingCatalogSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const { artist, musicbrainz_id, release_types, include_compilations, force_refresh } =
    parsed.data;
  const config = getConfig();

  // Step 1: Resolve artist MBID
  let artistMbid = musicbrainz_id;
  let artistName = artist;

  if (!artistMbid) {
    const searchResults = await musicbrainz.searchArtist(artist, 5);

    if (searchResults.length === 0) {
      throw new AppError(
        "MUSICBRAINZ_UNAVAILABLE",
        `No MusicBrainz results for "${artist}"`,
        404
      );
    }

    const highConfidence = searchResults.filter(
      (r) => r.name.toLowerCase() === artist.toLowerCase()
    );

    if (highConfidence.length > 1) {
      throw new AppError(
        "AMBIGUOUS_ARTIST",
        "Multiple MusicBrainz artists match this name.",
        409,
        false,
        {
          artists: highConfidence.slice(0, 5).map((a) => ({
            name: a.name,
            musicbrainz_id: a.id,
            disambiguation: a.disambiguation,
            type: a.type,
            country: a.country,
          })),
        }
      );
    }

    const bestMatch = highConfidence[0] ?? searchResults[0];
    if (!bestMatch) {
      throw new AppError(
        "MUSICBRAINZ_UNAVAILABLE",
        `Could not resolve artist "${artist}"`,
        404
      );
    }

    artistMbid = bestMatch.id;
    artistName = bestMatch.name;

    upsertCatalogArtist({
      mbid: artistMbid,
      name: artistName,
      disambiguation: bestMatch.disambiguation,
    });

    if (bestMatch.aliases.length > 0) {
      clearAliasesForArtist(bestMatch.name);
      addAliases(
        bestMatch.name,
        bestMatch.aliases.map((a) => ({
          name: a.name,
          source: "musicbrainz",
          confidence: 0.95,
        }))
      );
    }
  } else {
    const existing = getCatalogArtist(artistMbid);
    if (existing) {
      artistName = existing.name;
    } else {
      upsertCatalogArtist({ mbid: artistMbid, name: artistName });
    }
  }

  // Step 2: Check local catalog cache
  const cachedArtist = getCatalogArtist(artistMbid);
  const staleThresholdDays = config.ARTIST_CACHE_DAYS;
  const needsRefresh =
    force_refresh ||
    !cachedArtist ||
    isCatalogStale(cachedArtist, staleThresholdDays);

  let catalogSource: "local" | "musicbrainz";
  let catalogEntries: CatalogEntry[];

  if (needsRefresh) {
    log("info", "catalog_refresh_from_mb", {
      artist: artistName,
      mbid: artistMbid,
      reason: force_refresh ? "forced" : "stale_or_missing",
    });

    try {
      const allGroups = await musicbrainz.getAllReleaseGroups(artistMbid);

      deleteReleaseGroupsForArtist(artistMbid);
      upsertReleaseGroups(
        artistMbid,
        allGroups.map((rg) => ({
          mbid: rg.id,
          title: rg.title,
          primaryType: rg.primaryType,
          secondaryTypes: rg.secondaryTypes,
          firstReleaseDate: rg.firstReleaseDate,
        }))
      );
      markCatalogChecked(artistMbid);

      catalogEntries = filterReleaseGroups(allGroups, release_types, include_compilations);
      catalogSource = "musicbrainz";
    } catch (err) {
      const localGroups = getReleaseGroupsForArtist(artistMbid);
      if (localGroups.length > 0) {
        log("warn", "catalog_mb_failed_using_local", {
          artist: artistName,
          local_count: localGroups.length,
        });
        catalogEntries = filterLocalGroups(localGroups, release_types, include_compilations);
        catalogSource = "local";
      } else {
        throw err;
      }
    }
  } else {
    const localGroups = getReleaseGroupsForArtist(artistMbid);
    catalogEntries = filterLocalGroups(localGroups, release_types, include_compilations);
    catalogSource = "local";

    log("info", "catalog_from_local_cache", {
      artist: artistName,
      mbid: artistMbid,
      release_groups: localGroups.length,
      filtered: catalogEntries.length,
      checked_at: cachedArtist?.catalog_checked_at,
    });
  }

  // Step 3: Match against Navidrome library
  const libraryResults = await navidrome.search3(artistName, {
    albumCount: 200,
    artistCount: 5,
    songCount: 0,
  });

  const matchResults = matchCatalogToLibrary(
    catalogEntries,
    libraryResults.albums,
    artistName
  );

  const summary = summarizeCatalogResults(matchResults);

  const missing = matchResults
    .filter((r) => r.classification === "missing")
    .map((r) => ({
      title: r.catalogTitle,
      type: r.type,
      date: r.date,
      musicbrainz_release_group_id: r.musicbrainzReleaseGroupId,
      confidence: Math.round(r.confidence * 100) / 100,
    }));

  const uncertain = matchResults
    .filter((r) => r.classification === "uncertain")
    .map((r) => ({
      catalog_title: r.catalogTitle,
      possible_library_match: r.possibleLibraryMatch,
      confidence: Math.round(r.confidence * 100) / 100,
      reason: r.reason,
    }));

  log("info", "catalog_missing_completed", {
    artist: artistName,
    source: catalogSource,
    catalog_releases: summary.catalogReleases,
    owned: summary.owned,
    missing: summary.missing,
    uncertain: summary.uncertain,
  });

  return c.json({
    artist: {
      name: artistName,
      musicbrainz_id: artistMbid,
    },
    catalog_source: catalogSource,
    catalog_checked_at: cachedArtist?.catalog_checked_at ?? new Date().toISOString(),
    summary: {
      catalog_releases: summary.catalogReleases,
      owned: summary.owned,
      missing: summary.missing,
      uncertain: summary.uncertain,
    },
    missing,
    uncertain,
  });
});

/**
 * Local-first bulk missing catalog across all cached artists.
 * Never hits MusicBrainz — use getMissingCatalog / getCatalogStats to grow the cache first.
 */
catalogRoutes.post("/catalog/library-missing", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = libraryMissingSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => i.message).join("; "),
      400
    );
  }

  const {
    release_types,
    include_compilations,
    min_missing,
    limit_artists,
    include_releases,
    only_checked,
  } = parsed.data;

  const freshness = getCatalogStats();
  const cachedArtists = listCatalogArtists({ onlyChecked: only_checked });

  if (cachedArtists.length === 0) {
    return c.json({
      catalog_source: "local",
      catalog_freshness: {
        total_artists: freshness.totalArtists,
        total_release_groups: freshness.totalReleaseGroups,
        fresh: freshness.freshArtists,
        stale: freshness.staleArtists,
        unknown: freshness.uncheckedArtists,
      },
      artists_compared: 0,
      summary: {
        artists_with_missing: 0,
        total_catalog_releases: 0,
        total_owned: 0,
        total_missing: 0,
        total_uncertain: 0,
      },
      artists: [],
      note: "No cached artists yet. Call getMissingCatalog for individual artists first to populate the local catalog.",
    });
  }

  log("info", "library_missing_start", {
    cached_artists: cachedArtists.length,
    release_types,
    min_missing,
    limit_artists,
  });

  const allAlbums = await navidrome.getAllAlbums();

  type ArtistResult = {
    name: string;
    musicbrainz_id: string;
    catalog_checked_at: string | null;
    summary: {
      catalog_releases: number;
      owned: number;
      missing: number;
      uncertain: number;
    };
    missing?: Array<{
      title: string;
      type?: string;
      date?: string;
      musicbrainz_release_group_id: string;
      confidence: number;
    }>;
    uncertain?: Array<{
      catalog_title: string;
      possible_library_match?: string;
      confidence: number;
      reason?: string;
    }>;
  };

  const artistResults: ArtistResult[] = [];
  let totalCatalog = 0;
  let totalOwned = 0;
  let totalMissing = 0;
  let totalUncertain = 0;

  for (const artist of cachedArtists) {
    const localGroups = getReleaseGroupsForArtist(artist.mbid);
    const catalogEntries = filterLocalGroups(
      localGroups,
      release_types,
      include_compilations
    );

    if (catalogEntries.length === 0) continue;

    const libraryAlbums = filterAlbumsForArtist(allAlbums, artist.name);
    const matchResults = matchCatalogToLibrary(
      catalogEntries,
      libraryAlbums,
      artist.name
    );
    const summary = summarizeCatalogResults(matchResults);

    totalCatalog += summary.catalogReleases;
    totalOwned += summary.owned;
    totalMissing += summary.missing;
    totalUncertain += summary.uncertain;

    if (summary.missing < min_missing) continue;

    const result: ArtistResult = {
      name: artist.name,
      musicbrainz_id: artist.mbid,
      catalog_checked_at: artist.catalog_checked_at,
      summary: {
        catalog_releases: summary.catalogReleases,
        owned: summary.owned,
        missing: summary.missing,
        uncertain: summary.uncertain,
      },
    };

    if (include_releases) {
      result.missing = matchResults
        .filter((r) => r.classification === "missing")
        .map((r) => ({
          title: r.catalogTitle,
          type: r.type,
          date: r.date,
          musicbrainz_release_group_id: r.musicbrainzReleaseGroupId,
          confidence: Math.round(r.confidence * 100) / 100,
        }));
      result.uncertain = matchResults
        .filter((r) => r.classification === "uncertain")
        .map((r) => ({
          catalog_title: r.catalogTitle,
          possible_library_match: r.possibleLibraryMatch,
          confidence: Math.round(r.confidence * 100) / 100,
          reason: r.reason,
        }));
    }

    artistResults.push(result);
  }

  artistResults.sort(
    (a, b) =>
      b.summary.missing - a.summary.missing ||
      a.name.localeCompare(b.name)
  );

  const limited = artistResults.slice(0, limit_artists);

  log("info", "library_missing_completed", {
    artists_compared: cachedArtists.length,
    artists_with_missing: artistResults.length,
    returned: limited.length,
    total_missing: totalMissing,
    library_albums: allAlbums.length,
  });

  return c.json({
    catalog_source: "local",
    catalog_freshness: {
      total_artists: freshness.totalArtists,
      total_release_groups: freshness.totalReleaseGroups,
      fresh: freshness.freshArtists,
      stale: freshness.staleArtists,
      unknown: freshness.uncheckedArtists,
    },
    artists_compared: cachedArtists.length,
    summary: {
      artists_with_missing: artistResults.length,
      total_catalog_releases: totalCatalog,
      total_owned: totalOwned,
      total_missing: totalMissing,
      total_uncertain: totalUncertain,
    },
    artists: limited,
  });
});

catalogRoutes.get("/catalog/stats", async (c) => {
  const stats = getCatalogStats();

  return c.json({
    catalog_freshness: {
      total_artists: stats.totalArtists,
      total_release_groups: stats.totalReleaseGroups,
      fresh: stats.freshArtists,
      stale: stats.staleArtists,
      unknown: stats.uncheckedArtists,
    },
  });
});

function filterLocalGroups(
  records: CatalogReleaseGroupRecord[],
  allowedTypes: string[],
  includeCompilations: boolean
): CatalogEntry[] {
  return filterReleaseGroups(
    records.map((r) => ({
      id: r.mbid,
      title: r.title,
      primaryType: r.primary_type ?? undefined,
      secondaryTypes: r.secondary_types_json
        ? (JSON.parse(r.secondary_types_json) as string[])
        : [],
      firstReleaseDate: r.first_release_date ?? undefined,
    })),
    allowedTypes,
    includeCompilations
  );
}

function filterAlbumsForArtist(
  albums: LibraryAlbum[],
  artistName: string
): LibraryAlbum[] {
  return albums.filter((album) => {
    const result = artistMatch(artistName, album.artist);
    return result.match || result.confidence >= 0.6;
  });
}
