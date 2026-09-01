import { artistMatch, titleMatch, normalizeForComparison } from "./normalization";
import type { LibraryAlbum } from "../services/navidrome";

function safeGetAliases(artist: string): { canonical_artist: string }[] {
  try {
    const { findCanonicalByAlias } = require("../db/repositories/aliases");
    return findCanonicalByAlias(artist);
  } catch {
    return [];
  }
}

export interface AlbumMatch {
  artist: string;
  title: string;
  year?: number;
  trackCount?: number;
  navidromeId: string;
  confidence: number;
  matchReasons: string[];
}

export interface AlbumMatchResult {
  matched: boolean;
  confidence: number;
  matches: AlbumMatch[];
}

export function matchLibraryAlbums(
  queryArtist: string,
  queryTitle: string,
  libraryAlbums: LibraryAlbum[],
  options?: { year?: number; releaseType?: string }
): AlbumMatchResult {
  const matches: AlbumMatch[] = [];

  for (const album of libraryAlbums) {
    const result = scoreAlbumMatch(queryArtist, queryTitle, album, options);
    if (result.confidence >= 0.5) {
      matches.push(result);
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);

  const topMatch = matches[0];
  const matched = topMatch ? topMatch.confidence >= 0.9 : false;
  const confidence = topMatch?.confidence ?? 0;

  return { matched, confidence, matches: matches.slice(0, 5) };
}

function scoreAlbumMatch(
  queryArtist: string,
  queryTitle: string,
  album: LibraryAlbum,
  options?: { year?: number; releaseType?: string }
): AlbumMatch {
  const reasons: string[] = [];
  let score = 0;

  // Artist matching (weight: 0.45)
  const artistResult = artistMatch(queryArtist, album.artist);
  if (artistResult.match) {
    score += artistResult.confidence * 0.45;
    reasons.push(artistResult.reason);
  } else {
    // Check aliases
    const aliases = safeGetAliases(queryArtist);
    const aliasFound = aliases.some(
      (a) =>
        normalizeForComparison(a.canonical_artist) ===
        normalizeForComparison(album.artist)
    );
    if (aliasFound) {
      score += 0.38;
      reasons.push("artist_alias");
    } else {
      score += artistResult.confidence * 0.1;
    }
  }

  // Title matching (weight: 0.50)
  const titleResult = titleMatch(queryTitle, album.title);
  if (titleResult.match) {
    score += titleResult.confidence * 0.50;
    reasons.push(titleResult.reason);
  } else {
    score += titleResult.confidence * 0.1;
  }

  // Year bonus
  if (options?.year && album.year) {
    if (album.year === options.year) {
      score += 0.08;
      reasons.push("year_match");
    } else if (Math.abs(album.year - options.year) <= 1) {
      score += 0.04;
      reasons.push("year_close");
    }
  }

  // Clamp to 0-1
  const confidence = Math.min(1.0, Math.max(0, score));

  return {
    artist: album.artist,
    title: album.title,
    year: album.year,
    trackCount: album.songCount,
    navidromeId: album.id,
    confidence,
    matchReasons: reasons,
  };
}

export function classifyConfidence(confidence: number): "matched" | "possible_match" | "not_found" {
  if (confidence >= 0.9) return "matched";
  if (confidence >= 0.65) return "possible_match";
  return "not_found";
}
