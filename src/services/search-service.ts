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
  findVariantByQueryFingerprint,
} from "../db/repositories/search-variants";
import * as slskd from "./slskd";

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
 * Single-flight registry for semantic identities. music-api is deployed as a
 * single process today, so this closes the phone/desktop race where two
 * simultaneous requests could both create the same slskd searches.
 */
const inFlightSemanticSearches = new Map<string, Promise<SemanticSearchResult>>();

/**
 * Core entrypoint: find or create a semantic search, reusing existing
 * slskd searches wherever possible. Explicit forceNew requests intentionally
 * bypass reuse/adoption and always create fresh slskd search variants.
 */
export async function getOrCreateSemanticSearch(
  params: SemanticSearchParams
): Promise<SemanticSearchResult> {
  const fingerprint = computeSemanticFingerprint(
    params.artist,
    params.title,
    params.releaseType
  );

  if (params.forceNew) {
    return getOrCreateSemanticSearchUnlocked(params, fingerprint);
  }

  const existingFlight = inFlightSemanticSearches.get(fingerprint);
  if (existingFlight) {
    log("info", "semantic_search_joined_inflight", {
      fingerprint,
      artist: params.artist,
      title: params.title,
    });
    return existingFlight;
  }

  const flight = getOrCreateSemanticSearchUnlocked(params, fingerprint).finally(() => {
    if (inFlightSemanticSearches.get(fingerprint) === flight) {
      inFlightSemanticSearches.delete(fingerprint);
    }
  });

  inFlightSemanticSearches.set(fingerprint, flight);
  return flight;
}

async function getOrCreateSemanticSearchUnlocked(
  params: SemanticSearchParams,
  fingerprint: string
): Promise<SemanticSearchResult> {
  const config = getConfig();

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

  let adoptedCount = 0;
  let createdCount = 0;
  const slskdSearchIds: string[] = [];
  const coveredFingerprints = new Set<string>();

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

  for (const query of queries) {
    const qfp = queryFingerprint(query);
    if (coveredFingerprints.has(qfp)) continue;
    coveredFingerprints.add(qfp);

    if (params.forceNew) {
      const slskdSearch = await slskd.startSearch(query);
      upsertSearchVariant({
        semanticSearchId: searchRecord.id,
        query,
        queryFingerprint: qfp,
        slskdSearchId: slskdSearch.id,
      });
      slskdSearchIds.push(slskdSearch.id);
      createdCount++;
      continue;
    }

    const { search: slskdSearch, reused } = await slskd.findOrStartSearch(
      query,
      (fp) => {
        const variant = findVariantByQueryFingerprint(fp);
        return variant ? { slskdSearchId: variant.slskd_search_id } : null;
      }
    );
    upsertSearchVariant({
      semanticSearchId: searchRecord.id,
      query,
      queryFingerprint: qfp,
      slskdSearchId: slskdSearch.id,
      discovered: reused,
    });
    slskdSearchIds.push(slskdSearch.id);
    if (reused) adoptedCount++;
    else createdCount++;
  }

  const uniqueIds = [...new Set(slskdSearchIds)];
  updateSlskdIds(searchRecord.id, uniqueIds);

  log("info", "semantic_search_created", {
    search_id: searchRecord.id,
    fingerprint,
    forced: Boolean(params.forceNew),
    adopted: adoptedCount,
    created: createdCount,
    total_variants: uniqueIds.length,
  });

  return {
    searchRecord: getSearchRecord(searchRecord.id) ?? searchRecord,
    slskdSearchIds: uniqueIds,
    reused: false,
    adoptedCount,
    createdCount,
  };
}

/**
 * For an existing semantic search, verify slskd search IDs still exist,
 * adopt any new matches, and create only variants that are truly missing.
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
  const activeFingerprints = new Set<string>();
  let adoptedCount = 0;
  let createdCount = 0;

  for (const variant of variants) {
    try {
      await slskd.getSearch(variant.slskd_search_id);
      activeIds.push(variant.slskd_search_id);
      activeFingerprints.add(variant.query_fingerprint);
    } catch {
      markVariantMissing(variant.id);
      log("info", "search_variant_missing_in_slskd", {
        variant_id: variant.id,
        slskd_search_id: variant.slskd_search_id,
        query: variant.query,
      });
    }
  }

  const legacyIds = search.slskd_search_ids_json
    ? (JSON.parse(search.slskd_search_ids_json) as string[])
    : [];

  const knownSlskdIds = new Set(variants.map((v) => v.slskd_search_id));
  for (const legacyId of legacyIds) {
    if (knownSlskdIds.has(legacyId)) continue;
    try {
      const slskdSearch = await slskd.getSearch(legacyId);
      const query = slskdSearch.searchText ?? "";
      const qfp = queryFingerprint(query || legacyId);
      upsertSearchVariant({
        semanticSearchId: search.id,
        query,
        queryFingerprint: qfp,
        slskdSearchId: legacyId,
        discovered: true,
      });
      activeIds.push(legacyId);
      activeFingerprints.add(qfp);
      adoptedCount++;
    } catch {
      // Legacy ID no longer exists in slskd.
    }
  }

  const queries = generateSearchQueries(
    params.artist,
    params.title,
    params.preferredFormats
  );

  const missingQueries = queries.filter(
    (q) => !activeFingerprints.has(queryFingerprint(q))
  );

  if (missingQueries.length > 0) {
    for (const query of missingQueries) {
      const qfp = queryFingerprint(query);
      if (activeFingerprints.has(qfp)) continue;

      const { search: slskdSearch, reused } = await slskd.findOrStartSearch(
        query,
        (fp) => {
          const variant = findVariantByQueryFingerprint(fp);
          return variant ? { slskdSearchId: variant.slskd_search_id } : null;
        }
      );
      upsertSearchVariant({
        semanticSearchId: search.id,
        query,
        queryFingerprint: qfp,
        slskdSearchId: slskdSearch.id,
        discovered: reused,
      });
      activeIds.push(slskdSearch.id);
      activeFingerprints.add(qfp);
      if (reused) adoptedCount++;
      else createdCount++;
    }
  }

  const uniqueIds = [...new Set(activeIds)];
  updateSlskdIds(search.id, uniqueIds);

  return { activeSlskdIds: uniqueIds, adoptedCount, createdCount };
}

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
  const raw = [
    `${artist} ${title}`,
    `${artist} - ${title}`,
    ...(preferredFormats[0] ? [`${artist} ${title} ${preferredFormats[0]}`] : []),
  ];

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const query of raw) {
    const fingerprint = queryFingerprint(query);
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(query);
  }
  return unique.slice(0, 4);
}

function updateSlskdIds(searchId: string, ids: string[]): void {
  const db = getDb();
  db.query("UPDATE searches SET slskd_search_ids_json = ? WHERE id = ?")
    .run(JSON.stringify(ids), searchId);
}
