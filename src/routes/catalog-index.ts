import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import {
  getCatalogStats,
  listCatalogArtists,
  getReleaseGroupsForArtist,
  type CatalogReleaseGroupRecord,
} from "../db/repositories/catalog";
import { matchCatalogToLibrary, summarizeCatalogResults, type CatalogEntry } from "../domain/catalog";
import { artistMatch } from "../domain/normalization";
import * as navidrome from "../services/navidrome";
import type { LibraryAlbum } from "../services/navidrome";

export const catalogIndexRoutes = new Hono();

const releaseTypeEnum = z.enum(["Album", "EP", "Single", "Live", "Compilation", "Remix", "Soundtrack", "Other"]);
const classificationEnum = z.enum(["owned", "uncertain", "missing"]);

const catalogIndexSchema = z.object({
  q: z.string().max(300).optional(),
  artist_mbids: z.array(z.string().uuid()).max(1000).optional(),
  artist_names: z.array(z.string().min(1).max(500)).max(1000).optional(),
  release_types: z.array(releaseTypeEnum).max(10).optional().default(["Album", "EP", "Single"]),
  include_compilations: z.boolean().optional().default(false),
  classifications: z.array(classificationEnum).max(3).optional(),
  year_from: z.number().int().min(1000).max(9999).optional(),
  year_to: z.number().int().min(1000).max(9999).optional(),
  sort: z.enum(["release_date_desc", "release_date_asc", "artist", "title", "missing_first"]).optional().default("release_date_desc"),
  limit: z.number().int().min(1).max(500).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});

const EXCLUDED_SECONDARY_TYPES = new Set([
  "Live",
  "Compilation",
  "DJ-mix",
  "Mixtape",
  "Remix",
  "Interview",
  "Audiobook",
  "Spokenword",
]);

function asCatalogEntry(record: CatalogReleaseGroupRecord): CatalogEntry {
  let secondaryTypes: string[] = [];
  try {
    secondaryTypes = record.secondary_types_json ? JSON.parse(record.secondary_types_json) : [];
  } catch {
    secondaryTypes = [];
  }
  return {
    id: record.mbid,
    title: record.title,
    primaryType: record.primary_type ?? undefined,
    secondaryTypes,
    firstReleaseDate: record.first_release_date ?? undefined,
  };
}

function filterReleaseGroups(records: CatalogReleaseGroupRecord[], allowedTypes: string[], includeCompilations: boolean) {
  const allowed = new Set(allowedTypes.map((type) => type.toLowerCase()));
  return records.map(asCatalogEntry).filter((entry) => {
    const primary = entry.primaryType?.toLowerCase() ?? "";
    if (allowed.size > 0 && !allowed.has(primary)) return false;
    if (!includeCompilations && entry.secondaryTypes.some((type) => EXCLUDED_SECONDARY_TYPES.has(type))) return false;
    return true;
  });
}

function albumsForArtist(albums: LibraryAlbum[], artistName: string) {
  return albums.filter((album) => {
    const result = artistMatch(artistName, album.artist);
    return result.match || result.confidence >= 0.6;
  });
}

function releaseYear(value?: string) {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

catalogIndexRoutes.post("/catalog/index", async (c) => {
  const parsed = catalogIndexSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }

  const input = parsed.data;
  if (input.year_from && input.year_to && input.year_from > input.year_to) {
    throw new AppError("VALIDATION_ERROR", "year_from must be less than or equal to year_to", 400);
  }

  const mbidFilter = input.artist_mbids?.length ? new Set(input.artist_mbids) : null;
  const nameFilter = input.artist_names?.length
    ? new Set(input.artist_names.map((name) => name.toLocaleLowerCase()))
    : null;
  const classificationFilter = input.classifications?.length ? new Set(input.classifications) : null;
  const q = input.q?.trim().toLocaleLowerCase() ?? "";

  const artists = listCatalogArtists({ onlyChecked: true }).filter((artist) => {
    if (mbidFilter && !mbidFilter.has(artist.mbid)) return false;
    if (nameFilter && !nameFilter.has(artist.name.toLocaleLowerCase())) return false;
    return true;
  });

  const allAlbums = await navidrome.getAllAlbums();
  const items: Array<{
    artist: string;
    musicbrainz_artist_id: string;
    catalog_checked_at: string | null;
    title: string;
    musicbrainz_release_group_id: string;
    type?: string;
    date?: string;
    classification: "owned" | "uncertain" | "missing";
    confidence: number;
    possible_library_match?: string;
    reason?: string;
  }> = [];

  const artistSummaries: Array<{
    artist: string;
    musicbrainz_artist_id: string;
    catalog_checked_at: string | null;
    catalog_releases: number;
    owned: number;
    missing: number;
    uncertain: number;
  }> = [];

  for (const artist of artists) {
    const entries = filterReleaseGroups(
      getReleaseGroupsForArtist(artist.mbid),
      input.release_types,
      input.include_compilations,
    );
    const matches = matchCatalogToLibrary(entries, albumsForArtist(allAlbums, artist.name), artist.name);
    const summary = summarizeCatalogResults(matches);
    artistSummaries.push({
      artist: artist.name,
      musicbrainz_artist_id: artist.mbid,
      catalog_checked_at: artist.catalog_checked_at,
      catalog_releases: summary.catalogReleases,
      owned: summary.owned,
      missing: summary.missing,
      uncertain: summary.uncertain,
    });

    for (const match of matches) {
      const year = releaseYear(match.date);
      if (classificationFilter && !classificationFilter.has(match.classification)) continue;
      if (input.year_from && (year == null || year < input.year_from)) continue;
      if (input.year_to && (year == null || year > input.year_to)) continue;
      if (q && !artist.name.toLocaleLowerCase().includes(q) && !match.catalogTitle.toLocaleLowerCase().includes(q)) continue;
      items.push({
        artist: artist.name,
        musicbrainz_artist_id: artist.mbid,
        catalog_checked_at: artist.catalog_checked_at,
        title: match.catalogTitle,
        musicbrainz_release_group_id: match.musicbrainzReleaseGroupId,
        type: match.type,
        date: match.date,
        classification: match.classification,
        confidence: Math.round(match.confidence * 100) / 100,
        possible_library_match: match.possibleLibraryMatch,
        reason: match.reason,
      });
    }
  }

  const classificationRank = { missing: 0, uncertain: 1, owned: 2 } as const;
  items.sort((a, b) => {
    switch (input.sort) {
      case "release_date_asc":
        return (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
      case "artist":
        return a.artist.localeCompare(b.artist) || (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title);
      case "title":
        return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
      case "missing_first":
        return classificationRank[a.classification] - classificationRank[b.classification] || (b.date ?? "").localeCompare(a.date ?? "") || a.artist.localeCompare(b.artist);
      case "release_date_desc":
      default:
        return (b.date ?? "").localeCompare(a.date ?? "") || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    }
  });

  artistSummaries.sort((a, b) => b.missing - a.missing || a.artist.localeCompare(b.artist));
  const total = items.length;
  const freshness = getCatalogStats();

  return c.json({
    catalog_source: "local",
    catalog_freshness: {
      total_artists: freshness.totalArtists,
      total_release_groups: freshness.totalReleaseGroups,
      fresh: freshness.freshArtists,
      stale: freshness.staleArtists,
      unknown: freshness.uncheckedArtists,
    },
    artists_compared: artists.length,
    total,
    offset: input.offset,
    limit: input.limit,
    items: items.slice(input.offset, input.offset + input.limit),
    artist_summaries: artistSummaries,
  });
});
