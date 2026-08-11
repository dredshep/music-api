import type { MBReleaseGroupResult } from "../services/musicbrainz";
import type { LibraryAlbum } from "../services/navidrome";
import { normalizeForComparison, titleMatch, artistMatch } from "./normalization";
import { classifyConfidence } from "./matching";

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

export interface CatalogEntry {
  id: string;
  title: string;
  primaryType?: string;
  secondaryTypes: string[];
  firstReleaseDate?: string;
  artistCredit?: string;
}

export interface CatalogMatchResult {
  catalogTitle: string;
  musicbrainzReleaseGroupId: string;
  type?: string;
  date?: string;
  classification: "owned" | "uncertain" | "missing";
  confidence: number;
  possibleLibraryMatch?: string;
  reason?: string;
}

export function filterReleaseGroups(
  groups: MBReleaseGroupResult[],
  allowedTypes: string[],
  includeCompilations: boolean
): CatalogEntry[] {
  const typesLower = new Set(allowedTypes.map((t) => t.toLowerCase()));

  return groups
    .filter((rg) => {
      // Filter by primary type
      const primary = rg.primaryType?.toLowerCase() ?? "";
      if (typesLower.size > 0 && !typesLower.has(primary)) return false;

      // Filter out excluded secondary types unless requested
      if (!includeCompilations && rg.secondaryTypes.length > 0) {
        const hasExcluded = rg.secondaryTypes.some((t) =>
          EXCLUDED_SECONDARY_TYPES.has(t)
        );
        if (hasExcluded) return false;
      }

      return true;
    })
    .map((rg) => ({
      id: rg.id,
      title: rg.title,
      primaryType: rg.primaryType,
      secondaryTypes: rg.secondaryTypes,
      firstReleaseDate: rg.firstReleaseDate,
      artistCredit: rg.artistCredit,
    }));
}

export function matchCatalogToLibrary(
  catalogEntries: CatalogEntry[],
  libraryAlbums: LibraryAlbum[],
  queryArtist: string
): CatalogMatchResult[] {
  const results: CatalogMatchResult[] = [];

  for (const entry of catalogEntries) {
    const matchResult = findBestLibraryMatch(entry, libraryAlbums, queryArtist);
    results.push(matchResult);
  }

  return results;
}

function findBestLibraryMatch(
  entry: CatalogEntry,
  libraryAlbums: LibraryAlbum[],
  queryArtist: string
): CatalogMatchResult {
  let bestConfidence = 0;
  let bestAlbum: LibraryAlbum | undefined;
  let bestReason = "";

  for (const album of libraryAlbums) {
    // Artist check
    const artistResult = artistMatch(queryArtist, album.artist);
    if (!artistResult.match && artistResult.confidence < 0.6) continue;

    // Title check
    const titleResult = titleMatch(entry.title, album.title);

    // Combine scores
    let confidence = 0;
    if (titleResult.match) {
      confidence = titleResult.confidence * 0.6 + artistResult.confidence * 0.4;
    } else {
      confidence = titleResult.confidence * 0.4 + artistResult.confidence * 0.2;
    }

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestAlbum = album;
      bestReason = titleResult.reason;
    }
  }

  const classification = classifyConfidence(bestConfidence);

  const result: CatalogMatchResult = {
    catalogTitle: entry.title,
    musicbrainzReleaseGroupId: entry.id,
    type: entry.primaryType,
    date: entry.firstReleaseDate,
    classification,
    confidence: bestConfidence,
  };

  if (classification === "uncertain" && bestAlbum) {
    result.possibleLibraryMatch = bestAlbum.title;
    result.reason = `Possible edition mismatch: ${bestReason}`;
  }

  return result;
}

export function summarizeCatalogResults(results: CatalogMatchResult[]): {
  catalogReleases: number;
  owned: number;
  missing: number;
  uncertain: number;
} {
  return {
    catalogReleases: results.length,
    owned: results.filter((r) => r.classification === "owned").length,
    missing: results.filter((r) => r.classification === "missing").length,
    uncertain: results.filter((r) => r.classification === "uncertain").length,
  };
}
