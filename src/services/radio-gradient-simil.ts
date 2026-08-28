import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig } from "../config";
import { normalizeForComparison } from "../domain/normalization";
import { log } from "../middleware/logging";
import * as navidrome from "./navidrome";
import {
  gradientRecording,
  type GradientRecording,
  type GradientRecordingNeighbor,
} from "./radio-gradient-recording-path";

const execFileAsync = promisify(execFile);
const INDEX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 45_000;
const INDEX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type GradientSimilIndexStatus = {
  enabled: boolean;
  running: boolean;
  library: string;
  embedder: "effnet-discogs";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
};

type SimilSearchRow = {
  rank?: unknown;
  score?: unknown;
  raw_score?: unknown;
  title?: unknown;
  artist?: unknown;
  path?: unknown;
};

let indexRunning = false;
let lastIndexStartedAt = 0;
let lastIndexCompletedAt = 0;
let lastIndexError: string | null = null;

function truthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function gradientSimilEnabled() {
  return truthy(process.env.GRADIENT_SIMIL_ENABLED) && Boolean(getConfig().LIBRARY_MUSIC_PATH);
}

function similCommand() {
  return process.env.GRADIENT_SIMIL_COMMAND?.trim() || "simil";
}

function similLibrary() {
  return process.env.GRADIENT_SIMIL_LIBRARY?.trim() || "gradient";
}

function similWorkers() {
  const value = Number(process.env.GRADIENT_SIMIL_WORKERS ?? 2);
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 2;
}

function minimumCosine() {
  const value = Number(process.env.GRADIENT_SIMIL_MIN_COSINE ?? 0.22);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0.22;
}

function insideLibrary(relativePath: string) {
  const root = path.resolve(getConfig().LIBRARY_MUSIC_PATH);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

async function resolveLocalPath(recording: GradientRecording) {
  const result = await navidrome.search3(`${recording.artist} ${recording.title}`, {
    artistCount: 0,
    albumCount: 0,
    songCount: 10,
  });
  const exact = result.songs.find((song) =>
    normalizeForComparison(song.artist) === normalizeForComparison(recording.artist)
    && normalizeForComparison(song.title) === normalizeForComparison(recording.title)
  );
  if (!exact) return null;
  const song = exact.path ? exact : await navidrome.getSong(exact.id);
  return song.path ? insideLibrary(song.path) : null;
}

/** Parse simil's stable --json output using raw cosine, never per-query min-max score. */
export function parseGradientSimilSearchJson(
  raw: string,
  source: GradientRecording,
  limit: number,
): GradientRecordingNeighbor[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const output: GradientRecordingNeighbor[] = [];
  const seen = new Set<string>();
  const minCosine = minimumCosine();

  for (const item of parsed as SimilSearchRow[]) {
    if (typeof item.artist !== "string" || typeof item.title !== "string") continue;
    if (typeof item.raw_score !== "number" || !Number.isFinite(item.raw_score)) continue;
    const cosine = Math.max(-1, Math.min(1, item.raw_score));
    if (cosine < minCosine) continue;
    const recording = gradientRecording(item.artist, item.title);
    if (recording.key === source.key || seen.has(recording.key)) continue;
    seen.add(recording.key);
    output.push({
      ...recording,
      similarity: Math.max(0.01, cosine),
      confidence: 0.96,
      provider: "local_effnet",
    });
    if (output.length >= limit) break;
  }
  return output;
}

/**
 * Query an already-built simil Discogs-EffNet index. The library index owns the
 * expensive per-file embeddings; this request computes only the source query
 * embedding when a persistent graph edge is not already cached.
 */
export async function searchGradientSimilNeighbors(
  source: GradientRecording,
  limit: number,
): Promise<GradientRecordingNeighbor[]> {
  if (!gradientSimilEnabled()) return [];
  const filePath = await resolveLocalPath(source);
  if (!filePath) return [];
  const { stdout } = await execFileAsync(similCommand(), [
    "search",
    filePath,
    "--top-k",
    String(Math.max(limit * 2, 30)),
    "--min-score",
    "-1",
    "--library",
    similLibrary(),
    "--json",
  ], {
    timeout: SEARCH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseGradientSimilSearchJson(stdout, source, limit);
}

/**
 * Start a non-blocking incremental index refresh at most once per cooldown.
 * simil itself fingerprints content + mtime and re-embeds only new/changed files.
 */
export function maybeQueueGradientSimilIndex(force = false) {
  if (!gradientSimilEnabled()) return getGradientSimilIndexStatus();
  const now = Date.now();
  if (indexRunning || (!force && lastIndexStartedAt && now - lastIndexStartedAt < INDEX_COOLDOWN_MS)) {
    return getGradientSimilIndexStatus();
  }
  indexRunning = true;
  lastIndexStartedAt = now;
  lastIndexError = null;
  const root = path.resolve(getConfig().LIBRARY_MUSIC_PATH);
  void execFileAsync(similCommand(), [
    "index",
    root,
    "--embedder",
    "effnet-discogs",
    "--library",
    similLibrary(),
    "--workers",
    String(similWorkers()),
  ], {
    timeout: INDEX_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).then(() => {
    lastIndexCompletedAt = Date.now();
    log("info", "gradient_simil_index_ready", { library: similLibrary(), embedder: "effnet-discogs" });
  }).catch((error) => {
    lastIndexError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    log("warn", "gradient_simil_index_failed", { library: similLibrary(), error: lastIndexError });
  }).finally(() => {
    indexRunning = false;
  });
  return getGradientSimilIndexStatus();
}

export function getGradientSimilIndexStatus(): GradientSimilIndexStatus {
  return {
    enabled: gradientSimilEnabled(),
    running: indexRunning,
    library: similLibrary(),
    embedder: "effnet-discogs",
    lastStartedAt: lastIndexStartedAt ? new Date(lastIndexStartedAt).toISOString() : null,
    lastCompletedAt: lastIndexCompletedAt ? new Date(lastIndexCompletedAt).toISOString() : null,
    lastError: lastIndexError,
  };
}
