/**
 * High-level search service implementing durable, cross-client search reuse.
 *
 * Semantic searches are identified by a canonical fingerprint derived from
 * (artist, title, release_type). A semantic search is never deleted — only
 * its candidate snapshot can become stale.
 *
 * Each semantic search is backed by one or more slskd "search variants"
 * (concrete query strings). Before creating slskd searches, we:
 *   1. check our persistent registry for an existing semantic search
 *   2. verify its associated slskd search IDs still exist
 *   3. scan slskd's search list for adoptable matches
 *   4. create only genuinely missing variants
 */

import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { getDb } from "../db/database";
import { computeSemanticFingerprint } from "../domain/normalization";
import {
  findSearchByFingerprint,
  createSearch,
  getSearch as getSearchRecord,
  touchSearchUsage,
  type SearchRecord,
} from "../db/repositories/searches";
import {
  upsertSearchVariant,
  getVariantsForSearch,
  markVariantMissing,
} from "../db/repositories/search-variants";
import * as slskd from "./slskd";
import type { SlskdSearchState } from "../types/upstream";

export interface SemanticSearchParams {
  artist: string;
  title: string;
  releaseType: string;
  preferredFormats: string[];
  preferLrc: boolean;
  maxCandidates: number;
  forceNew?: boolean;
}

export interface SemanticSearchResult {
  searchRecord: SearchRecord;
  slskdSearchIds: string[];
  reused: boolean;
  adoptedCount: number;
  createdCount: number;
}

/**
 * Core entrypoint: find or create a semantic search, reusing existing
 * slskd searches wherever possible.
 */
export async function getOrCreateSemanticSearch(
  params: SemanticSearchParams
): Promise<SemanticSearchResult> {
  const config = getConfig();
  const fingerprint = computeSemanticFingerprint(
    params.artist,
    params.title,
    params.releaseType
  );

  if (!params.forceNew) {
    const existing = findSearchByFingerprint(fingerprint);
    if (existing) {
      log("info", "semantic_search_reused", {
        search_id: existing.id,
        fingerprint,
        artist: params.artist,
        title: params.title,
      });

      touchSearchUsage(existing.id);
      const result = await reconcileSearchVariants(existing, params);
      return {
        searchRecord: getSearchRecord(existing.id) ?? existing,
        slskdSearchIds: result.activeSlskdIds,
        reused: true,
        adoptedCount: result.adoptedCount,
        createdCount: result.createdCount,
      };
    }
  }

  const queries = generateSearchQueries(
    params.artist,
    params.title,
    params.preferredFormats
  );

  // Before creating anything in slskd, try to adopt existing slskd searches
  let adoptedCount = 0;
  let createdCount = 0;
  const slskdSearchIds: string[] = [];

  const adoptable = await findAdoptableSlskdSearches(queries);

  const searchRecord = createSearch({
    artist: params.artist,
    title: params.title,
    releaseType: params.releaseType,
    rawQuery: queries.join(" | "),
    slskdSearchIds: [],
    ttlMinutes: config.SEARCH_RESULT_TTL_MINUTES,
    preferredFormats: params.preferredFormats,
    preferLrc: params.preferLrc,
    maxCandidates: params.maxCandidates,
  });

  // Register adopted searches as variants
  for (const adopted of adoptable) {
    const qfp = queryFingerprint(adopted.matchedQuery);
    upsertSearchVariant({
      semanticSearchId: searchRecord.id,
      query: adopted.matchedQuery,
      queryFingerprint: qfp,
      slskdSearchId: adopted.slskdSearch.id,
      discovered: true,
    });
    slskdSearchIds.push(adopted.slskdSearch.id);
    adoptedCount++;
  }

  // Create only missing query variants
  const adoptedFingerprints = new Set(
    adoptable.map((a) => queryFingerprint(a.matchedQuery))
  );

  for (const query of queries) {
    const qfp = queryFingerprint(query);
    if (adoptedFingerprints.has(qfp)) continue;

    const slskdSearch = await slskd.startSearch(query);
    upsertSearchVariant({
      semanticSearchId: searchRecord.id,
      query,
      queryFingerprint: qfp,
      slskdSearchId: slskdSearch.id,
    });
    slskdSearchIds.push(slskdSearch.id);
    createdCount++;
  }

  // Update the legacy slskd_search_ids_json column for compatibility
  updateSlskdIds(searchRecord.id, slskdSearchIds);

  log("info", "semantic_search_created", {
    search_id: searchRecord.id,
    fingerprint,
    adopted: adoptedCount,
    created: createdCount,
    total_variants: slskdSearchIds.length,
  });

  return {
    searchRecord: getSearchRecord(searchRecord.id) ?? searchRecord,
    slskdSearchIds,
    reused: false,
    adoptedCount,
    createdCount,
  };
}

/**
 * For an existing semantic search, verify slskd search IDs still exist,
 * adopt any new matches, and create missing variants.
 */
async function reconcileSearchVariants(
  search: SearchRecord,
  params: SemanticSearchParams
): Promise<{
  activeSlskdIds: string[];
  adoptedCount: number;
  createdCount: number;
}> {
  const variants = getVariantsForSearch(search.id);
  const activeIds: string[] = [];
  let adoptedCount = 0;
  let createdCount = 0;

  // Verify each existing variant's slskd search still exists
  for (const variant of variants) {
    try {
      await slskd.getSearch(variant.slskd_search_id);
      activeIds.push(variant.slskd_search_id);
    } catch {
      markVariantMissing(variant.id);
      log("info", "search_variant_missing_in_slskd", {
        variant_id: variant.id,
        slskd_search_id: variant.slskd_search_id,
        query: variant.query,
      });
    }
  }

  // Also check the legacy slskd_search_ids_json for IDs not yet in variants table
  const legacyIds = search.slskd_search_ids_json
    ? (JSON.parse(search.slskd_search_ids_json) as string[])
    : [];

  const knownSlskdIds = new Set(variants.map((v) => v.slskd_search_id));
  for (const legacyId of legacyIds) {
    if (knownSlskdIds.has(legacyId)) continue;
    try {
      const slskdSearch = await slskd.getSearch(legacyId);
      upsertSearchVariant({
        semanticSearchId: search.id,
        query: slskdSearch.searchText ?? "",
        queryFingerprint: queryFingerprint(slskdSearch.searchText ?? legacyId),
        slskdSearchId: legacyId,
        discovered: true,
      });
      activeIds.push(legacyId);
      adoptedCount++;
    } catch {
      // Legacy ID no longer valid
    }
  }

  // Generate expected queries and find any that are missing
  const queries = generateSearchQueries(
    params.artist,
    params.title,
    params.preferredFormats
  );

  const existingFingerprints = new Set([
    ...variants.filter((v) => !v.missing_at).map((v) => v.query_fingerprint),
  ]);

  const missingQueries = queries.filter(
    (q) => !existingFingerprints.has(queryFingerprint(q))
  );

  if (missingQueries.length > 0) {
    // Try to adopt from slskd first
    const adoptable = await findAdoptableSlskdSearches(missingQueries);
    const adoptedFps = new Set<string>();

    for (const adopted of adoptable) {
      const qfp = queryFingerprint(adopted.matchedQuery);
      upsertSearchVariant({
        semanticSearchId: search.id,
        query: adopted.matchedQuery,
        queryFingerprint: qfp,
        slskdSearchId: adopted.slskdSearch.id,
        discovered: true,
      });
      activeIds.push(adopted.slskdSearch.id);
      adoptedFps.add(qfp);
      adoptedCount++;
    }

    // Create what's still missing
    for (const query of missingQueries) {
      const qfp = queryFingerprint(query);
      if (adoptedFps.has(qfp)) continue;

      const slskdSearch = await slskd.startSearch(query);
      upsertSearchVariant({
        semanticSearchId: search.id,
        query,
        queryFingerprint: qfp,
        slskdSearchId: slskdSearch.id,
      });
      activeIds.push(slskdSearch.id);
      createdCount++;
    }
  }

  // Update legacy column
  const uniqueIds = [...new Set(activeIds)];
  updateSlskdIds(search.id, uniqueIds);

  return { activeSlskdIds: uniqueIds, adoptedCount, createdCount };
}

interface AdoptableSearch {
  slskdSearch: SlskdSearchState;
  matchedQuery: string;
}

/**
 * Scan slskd's search registry for existing searches that match our
 * intended query variants. This allows adoption of searches created
 * by other clients, before this migration, or from previous sessions.
 */
async function findAdoptableSlskdSearches(
  queries: string[]
): Promise<AdoptableSearch[]> {
  try {
    const existingSearches = await slskd.listSearches();
    const adoptable: AdoptableSearch[] = [];
    const adopted = new Set<string>();

    for (const query of queries) {
      const qfp = queryFingerprint(query);

      for (const existing of existingSearches) {
        if (adopted.has(existing.id)) continue;
        const existingFp = queryFingerprint(existing.searchText ?? "");
        if (existingFp === qfp) {
          adoptable.push({ slskdSearch: existing, matchedQuery: query });
          adopted.add(existing.id);
          break;
        }
      }
    }

    return adoptable;
  } catch (err) {
    log("warn", "slskd_list_searches_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Normalize a query string into a fingerprint for deduplication.
 * Same logic as slskd service's existing searchFingerprint.
 */
function queryFingerprint(query: string): string {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u2010-\u2015-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateSearchQueries(
  artist: string,
  title: string,
  preferredFormats: string[]
): string[] {
  const queries: string[] = [];
  queries.push(`${artist} ${title}`);
  queries.push(`${artist} - ${title}`);
  const topFormat = preferredFormats[0];
  if (topFormat) {
    queries.push(`${artist} ${title} ${topFormat}`);
  }
  return queries.slice(0, 4);
}

function updateSlskdIds(searchId: string, ids: string[]): void {
  const db = getDb();
  db.query("UPDATE searches SET slskd_search_ids_json = ? WHERE id = ?")
    .run(JSON.stringify(ids), searchId);
}
