import { getDb } from "../db/database";
import * as lastfm from "./lastfm";
import * as listenbrainz from "./listenbrainz";
import {
  gradientRecording,
  type GradientRecording,
  type GradientRecordingNeighbor,
  type GradientRecordingNeighborProvider,
} from "./radio-gradient-recording-path";
import {
  gradientSimilEnabled,
  maybeQueueGradientSimilIndex,
  searchGradientSimilNeighbors,
} from "./radio-gradient-simil";

const READY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 15 * 60 * 1000;

interface CachedNodeRow {
  canonical_key: string;
  artist: string;
  title: string;
  recording_mbid: string | null;
}

interface CachedEdgeRow extends CachedNodeRow {
  provider: string;
  similarity: number;
  confidence: number;
}

interface FetchRow {
  provider: string;
  status: string;
  result_count: number;
  retrieved_at: string;
}

export interface GradientRecordingProviderDiagnostics {
  neighborLookups: number;
  cacheHits: number;
  cacheMisses: number;
  providerCalls: Record<string, number>;
  providerRows: Record<string, number>;
  providerErrors: Record<string, number>;
}

export interface CachedGradientRecordingProvider extends GradientRecordingNeighborProvider {
  diagnostics(): GradientRecordingProviderDiagnostics;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function rememberNode(recording: GradientRecording) {
  const now = nowIso();
  getDb().query(`INSERT INTO recording_similarity_nodes
      (canonical_key,artist,title,recording_mbid,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(canonical_key) DO UPDATE SET
        artist=excluded.artist,
        title=excluded.title,
        recording_mbid=COALESCE(excluded.recording_mbid,recording_similarity_nodes.recording_mbid),
        updated_at=excluded.updated_at`)
    .run(recording.key, recording.artist, recording.title, recording.mbid, now);
}

function rememberFetch(sourceKey: string, provider: string, status: "ready" | "failed", count: number, error?: string | null) {
  getDb().query(`INSERT INTO recording_similarity_fetches
      (source_key,provider,status,result_count,error,retrieved_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(source_key,provider) DO UPDATE SET
        status=excluded.status,result_count=excluded.result_count,error=excluded.error,retrieved_at=excluded.retrieved_at`)
    .run(sourceKey, provider, status, count, error?.slice(0, 1000) ?? null, nowIso());
}

function rememberEdges(source: GradientRecording, provider: string, rows: GradientRecordingNeighbor[]) {
  const now = nowIso();
  const directionality = provider === "local_effnet" ? "acoustic" : "observed";
  const insert = getDb().query(`INSERT INTO recording_similarity_edges
      (source_key,target_key,provider,similarity,confidence,directionality,metadata_json,retrieved_at)
      VALUES (?,?,?,?,?,?,NULL,?)
      ON CONFLICT(source_key,target_key,provider) DO UPDATE SET
        similarity=excluded.similarity,
        confidence=excluded.confidence,
        directionality=excluded.directionality,
        retrieved_at=excluded.retrieved_at`);
  getDb().transaction(() => {
    rememberNode(source);
    for (const row of rows) {
      rememberNode(row);
      insert.run(
        source.key,
        row.key,
        provider,
        clamp(row.similarity, 0.01, 1),
        clamp(row.confidence ?? 0.75, 0.05, 1),
        directionality,
        now,
      );
    }
    rememberFetch(source.key, provider, "ready", rows.length);
  })();
}

function fetchState(sourceKey: string, provider: string): FetchRow | null {
  return getDb().query<FetchRow, [string, string]>(
    "SELECT provider,status,result_count,retrieved_at FROM recording_similarity_fetches WHERE source_key=? AND provider=?",
  ).get(sourceKey, provider) ?? null;
}

function isFresh(row: FetchRow | null) {
  if (!row) return false;
  const age = Date.now() - Date.parse(row.retrieved_at);
  if (!Number.isFinite(age)) return false;
  return age < (row.status === "ready" ? READY_TTL_MS : FAILED_TTL_MS);
}

function cachedEdges(sourceKey: string, limit: number): GradientRecordingNeighbor[] {
  const rows = getDb().query<CachedEdgeRow, [string, number]>(`SELECT
      n.canonical_key,n.artist,n.title,n.recording_mbid,
      e.provider,e.similarity,e.confidence
    FROM recording_similarity_edges e
    JOIN recording_similarity_nodes n ON n.canonical_key=e.target_key
    WHERE e.source_key=?
    ORDER BY (e.similarity*e.confidence) DESC,e.similarity DESC
    LIMIT ?`).all(sourceKey, Math.max(limit * 4, limit));

  const merged = new Map<string, GradientRecordingNeighbor>();
  const providers = new Map<string, Set<string>>();
  for (const row of rows) {
    const current = merged.get(row.canonical_key);
    const evidence = row.similarity * row.confidence;
    const currentEvidence = current ? current.similarity * (current.confidence ?? 0.75) : -1;
    if (!current || evidence > currentEvidence) {
      merged.set(row.canonical_key, {
        key: row.canonical_key,
        artist: row.artist,
        title: row.title,
        mbid: row.recording_mbid,
        similarity: clamp(row.similarity, 0.01, 1),
        confidence: clamp(row.confidence, 0.05, 1),
        provider: row.provider,
      });
    }
    const set = providers.get(row.canonical_key) ?? new Set<string>();
    set.add(row.provider);
    providers.set(row.canonical_key, set);
  }

  // Independent provider agreement increases confidence, never raw similarity.
  for (const [key, row] of merged) {
    const count = providers.get(key)?.size ?? 1;
    if (count > 1) row.confidence = clamp((row.confidence ?? 0.75) + Math.min(0.18, (count - 1) * 0.09), 0.05, 1);
  }
  return [...merged.values()]
    .sort((a, b) => b.similarity * (b.confidence ?? 0.75) - a.similarity * (a.confidence ?? 0.75))
    .slice(0, limit);
}

async function fetchLastFm(source: GradientRecording, limit: number) {
  const rows = await lastfm.getSimilarTracks(source.artist, source.title, Math.max(limit, 40));
  return rows
    .filter((row) => row.artist.trim() && row.name.trim() && row.match > 0)
    .map((row) => ({
      ...gradientRecording(row.artist, row.name, row.mbid || null),
      similarity: clamp(row.match, 0.01, 1),
      confidence: 0.82,
      provider: "lastfm_track",
    } satisfies GradientRecordingNeighbor));
}

async function fetchListenBrainz(source: GradientRecording, limit: number) {
  if (!source.mbid) return [] as GradientRecordingNeighbor[];
  const rows = await listenbrainz.getSimilarRecordings(source.mbid, Math.max(limit, 40));
  return rows.map((row) => ({
    ...gradientRecording(row.artist, row.title, row.recordingMbid),
    similarity: clamp(row.score, 0.01, 1),
    confidence: 0.76,
    provider: "listenbrainz_similar",
  } satisfies GradientRecordingNeighbor));
}

/**
 * Persistent cache-first provider for the global recording graph. Provider rows
 * are stored separately so agreement can increase confidence without pretending
 * collaborative similarity is acoustic truth. When enabled, local Discogs-EffNet
 * neighbors from simil are stored in the same cache as independent acoustic edges.
 */
export function createCachedGradientRecordingProvider(): CachedGradientRecordingProvider {
  const stats: GradientRecordingProviderDiagnostics = {
    neighborLookups: 0,
    cacheHits: 0,
    cacheMisses: 0,
    providerCalls: {},
    providerRows: {},
    providerErrors: {},
  };

  const increment = (bucket: Record<string, number>, key: string, amount = 1) => {
    bucket[key] = (bucket[key] ?? 0) + amount;
  };

  const ensureProvider = async (
    source: GradientRecording,
    providerName: string,
    fetcher: () => Promise<GradientRecordingNeighbor[]>,
  ) => {
    const state = fetchState(source.key, providerName);
    if (isFresh(state)) {
      stats.cacheHits++;
      return;
    }
    stats.cacheMisses++;
    increment(stats.providerCalls, providerName);
    try {
      const rows = await fetcher();
      rememberEdges(source, providerName, rows);
      increment(stats.providerRows, providerName, rows.length);
    } catch (error) {
      rememberNode(source);
      rememberFetch(source.key, providerName, "failed", 0, error instanceof Error ? error.message : String(error));
      increment(stats.providerErrors, providerName);
    }
  };

  return {
    async neighbors(source, limit) {
      stats.neighborLookups++;
      rememberNode(source);
      if (gradientSimilEnabled()) maybeQueueGradientSimilIndex();
      await Promise.all([
        ensureProvider(source, "lastfm_track", () => fetchLastFm(source, limit)),
        source.mbid
          ? ensureProvider(source, "listenbrainz_similar", () => fetchListenBrainz(source, limit))
          : Promise.resolve(),
        gradientSimilEnabled()
          ? ensureProvider(source, "local_effnet", () => searchGradientSimilNeighbors(source, limit))
          : Promise.resolve(),
      ]);
      return cachedEdges(source.key, limit);
    },
    diagnostics() {
      return {
        ...stats,
        providerCalls: { ...stats.providerCalls },
        providerRows: { ...stats.providerRows },
        providerErrors: { ...stats.providerErrors },
      };
    },
  };
}
