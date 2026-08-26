import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";
import type {
  SlskdSearchState,
  SlskdSearchResponseRaw,
  SlskdSearchResponse,
  SlskdDownloadState,
  SlskdUserDirectory,
  SlskdFile,
} from "../types/upstream";
import { normalizeSearchResponse, isSearchComplete } from "../types/upstream";

function getBaseUrl(): string {
  const config = getConfig();
  return `${config.SLSKD_URL}/api/${config.SLSKD_API_VERSION}`;
}

function getHeaders(): Record<string, string> {
  const config = getConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.SLSKD_API_KEY) {
    headers["X-API-Key"] = config.SLSKD_API_KEY;
  }
  return headers;
}

/** slskd permits only one concurrent mutating search operation — serialize starts. */
let searchStartChain: Promise<void> = Promise.resolve();

function withSearchStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = searchStartChain.then(fn, fn);
  searchStartChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function slskdFetch<T>(
  path: string,
  options: RequestInit = {},
  retryCount = 0
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...getHeaders(), ...(options.headers as Record<string, string>) },
      signal: controller.signal,
    });

    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      const maxRetries = 5;
      if (retryCount < maxRetries) {
        const backoffMs = Math.min(1000 * 2 ** retryCount, 8000);
        log("warn", "slskd_rate_limited_retry", {
          path,
          retry: retryCount + 1,
          backoff_ms: backoffMs,
          body: body.slice(0, 200),
        });
        await sleep(backoffMs);
        return slskdFetch<T>(path, options, retryCount + 1);
      }
      throw new AppError(
        "SLSKD_RATE_LIMITED",
        `slskd rate limited after ${maxRetries} retries: ${body.slice(0, 200)}`,
        429,
        true
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError(
        "SLSKD_UNAVAILABLE",
        `slskd returned ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        502,
        true
      );
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "slskd connection failed";
    throw new AppError("SLSKD_UNAVAILABLE", message, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function ping(): Promise<boolean> {
  try {
    await slskdFetch("/application");
    return true;
  } catch {
    return false;
  }
}

export async function getVersion(): Promise<string> {
  const data = await slskdFetch<{ version?: string }>("/application");
  return data?.version ?? "unknown";
}

export async function startSearch(query: string): Promise<SlskdSearchState> {
  return withSearchStartLock(async () => {
    log("info", "slskd_search_start", { query });
    return slskdFetch<SlskdSearchState>("/searches", {
      method: "POST",
      body: JSON.stringify({ searchText: query }),
    });
  });
}

function searchFingerprint(query: string): string {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u2010-\u2015-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Start unique query variants serially (slskd allows only one concurrent start). */
export async function startSearches(queries: string[]): Promise<SlskdSearchState[]> {
  const results: SlskdSearchState[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const fingerprint = searchFingerprint(query);
    if (!fingerprint || seen.has(fingerprint)) {
      log("info", "slskd_search_variant_deduped", { query, fingerprint });
      continue;
    }
    seen.add(fingerprint);
    results.push(await startSearch(query));
  }
  return results;
}

export async function getSearch(searchId: string): Promise<SlskdSearchState> {
  return slskdFetch<SlskdSearchState>(`/searches/${searchId}`);
}

export async function getSearchResponses(
  searchId: string
): Promise<SlskdSearchResponse[]> {
  const raw = await slskdFetch<SlskdSearchResponseRaw[]>(
    `/searches/${searchId}/responses`
  );
  if (!Array.isArray(raw)) {
    log("warn", "slskd_adapter_warning", {
      warning: "search_responses_not_array",
      search_id: searchId,
      received_type: typeof raw,
    });
    return [];
  }
  return raw.map(normalizeSearchResponse);
}

/**
 * Retrieve a user's shared directory.
 *
 * slskd requires POST with the directory path as the JSON body
 * and returns an array of directory objects. File entries may
 * contain basenames — we reconstruct full remote paths.
 */
export async function getUserDirectory(
  username: string,
  directory?: string
): Promise<SlskdUserDirectory> {
  if (!directory) {
    return { name: "", files: [], directories: [] };
  }

  const rawResult = await slskdFetch<SlskdUserDirectory[] | SlskdUserDirectory>(
    `/users/${encodeURIComponent(username)}/directory`,
    {
      method: "POST",
      body: JSON.stringify(directory),
    }
  );

  if (!rawResult) {
    log("warn", "slskd_adapter_warning", {
      warning: "directory_empty_response",
      username,
      directory,
    });
    return { name: directory, files: [], directories: [] };
  }

  const dirs: SlskdUserDirectory[] = Array.isArray(rawResult)
    ? rawResult
    : [rawResult];

  const allFiles: SlskdFile[] = [];
  const subDirectories: SlskdUserDirectory[] = [];

  for (const dir of dirs) {
    if (!dir.files || !Array.isArray(dir.files)) continue;

    for (const file of dir.files) {
      const filename = looksLikeBasename(file.filename, directory)
        ? joinRemotePath(dir.name || directory, file.filename)
        : file.filename;
      allFiles.push({ ...file, filename });
    }

    if (dir.directories) {
      subDirectories.push(...dir.directories);
    }
  }

  return {
    name: directory,
    files: allFiles,
    directories: subDirectories.length > 0 ? subDirectories : undefined,
  };
}

function looksLikeBasename(filename: string, directory: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.includes("/")) return false;
  if (normalized.startsWith(directory.replace(/\\/g, "/"))) return false;
  return true;
}

function joinRemotePath(directory: string, basename: string): string {
  const sep = directory.includes("\\") ? "\\" : "/";
  const dir = directory.replace(/[/\\]$/, "");
  return `${dir}${sep}${basename}`;
}

export interface RemoteFile {
  filename: string;
  size: number;
}

export async function enqueueFiles(
  username: string,
  files: RemoteFile[]
): Promise<void> {
  const seen = new Set<string>();
  const unique: RemoteFile[] = [];
  for (const f of files) {
    if (seen.has(f.filename)) continue;
    seen.add(f.filename);
    unique.push(f);
  }

  if (unique.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "No files to enqueue after deduplication",
      400
    );
  }

  await slskdFetch(`/transfers/downloads/${encodeURIComponent(username)}`, {
    method: "POST",
    body: JSON.stringify(unique.map((f) => ({ filename: f.filename, size: f.size }))),
  });
}

export async function getDownloads(): Promise<SlskdDownloadState[]> {
  return slskdFetch<SlskdDownloadState[]>("/transfers/downloads");
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLocaleLowerCase();
}

function remoteBasename(value: string): string {
  const normalized = normalizeRemotePath(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Best-effort confirmation that slskd created a transfer after accepting POST. */
export async function waitForEnqueuedFiles(
  username: string,
  files: RemoteFile[],
  timeoutMs = 5000
): Promise<boolean> {
  const wantedPaths = new Set(files.map((file) => normalizeRemotePath(file.filename)));
  const wantedNames = new Set(files.map((file) => remoteBasename(file.filename)));
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (Date.now() <= deadline) {
    try {
      const downloads = await getDownloads();
      const user = downloads.find((entry) => entry.username === username);
      if (user) {
        for (const directory of user.directories ?? []) {
          for (const file of directory.files ?? []) {
            const candidatePath = normalizeRemotePath(file.filename);
            if (wantedPaths.has(candidatePath) || wantedNames.has(remoteBasename(candidatePath))) {
              return true;
            }
          }
        }
      }
    } catch {
      // POST already succeeded; verification must never turn a successful queue
      // request into a false hard failure because the status endpoint hiccupped.
    }
    await sleep(500);
  }

  return false;
}

export async function cancelTransfer(
  username: string,
  transferId: string
): Promise<void> {
  await slskdFetch(
    `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(transferId)}`,
    { method: "DELETE" }
  );
}

export async function retryTransfer(
  username: string,
  transferId: string
): Promise<void> {
  await slskdFetch(
    `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(transferId)}`,
    { method: "PUT" }
  );
}

// --- Adaptive search collection ---

export interface SearchCollectionDiagnostics {
  rawFileCount: number;
  lockedFileCount: number;
  peerResponseCount: number;
  uniquePeers: number;
  uniqueDirectories: number;
  audioDirectories: number;
  lrcDirectories: number;
  searchStates: Array<{ id: string; state: string; isComplete: boolean; fileCount: number }>;
  collectionMs: number;
  settled: boolean;
}

export interface SearchCollectionResult {
  responses: SlskdSearchResponse[];
  diagnostics: SearchCollectionDiagnostics;
}

/**
 * Adaptive search collection that replaces the old `waitForSearchCompletion`.
 *
 * Policy:
 *  - Poll every 1s.
 *  - Keep existing SEARCH_COLLECTION_MS (default 7s) as the minimum wait.
 *  - After the minimum, return early if ≥1 audio-bearing directory exists.
 *  - Otherwise wait until all slskd searches report complete or `maxMs` elapses.
 */
export async function collectSearchResults(
  searchIds: string[],
  opts: {
    minMs?: number;
    maxMs?: number;
    preferLrc?: boolean;
  } = {}
): Promise<SearchCollectionResult> {
  const config = getConfig();
  const preferLrc = opts.preferLrc ?? false;
  const minMs = opts.minMs ?? config.SEARCH_COLLECTION_MS;
  const maxMs = opts.maxMs ?? (preferLrc ? 45000 : 30000);
  const pollMs = 1000;
  const startedAt = Date.now();

  let lastResponses: SlskdSearchResponse[] = [];
  let lastStates: SlskdSearchState[] = [];

  while (true) {
    const elapsed = Date.now() - startedAt;

    const states = await Promise.all(
      searchIds.map((id) => getSearch(id).catch(() => null))
    );
    lastStates = states.filter((s): s is SlskdSearchState => s !== null);
    const allSettled = lastStates.length > 0 && lastStates.every(isSearchComplete);

    const responseSets = await Promise.all(
      searchIds.map((id) => getSearchResponses(id).catch(() => []))
    );
    lastResponses = responseSets.flat();

    const pastMinimum = elapsed >= minMs;
    const pastMaximum = elapsed >= maxMs;

    if (pastMinimum) {
      const audioDirs = countAudioDirectories(lastResponses);

      if (preferLrc && audioDirs > 0 && !allSettled && !pastMaximum) {
        const lrcDirs = countLrcDirectories(lastResponses);
        if (lrcDirs > 0 || allSettled || pastMaximum) {
          break;
        }
      } else if (audioDirs > 0 || allSettled || pastMaximum) {
        break;
      }
    }

    if (pastMaximum) break;

    await sleep(pollMs);
  }

  const diag = buildDiagnostics(lastResponses, lastStates, Date.now() - startedAt);
  return { responses: lastResponses, diagnostics: diag };
}

/**
 * Refresh collection: for an existing search, return immediately if
 * candidates already exist in the responses. If empty and still
 * collecting, wait up to `waitMs` for a viable directory or settlement.
 */
export async function refreshSearchResults(
  searchIds: string[],
  opts: { waitMs?: number } = {}
): Promise<SearchCollectionResult> {
  const waitMs = opts.waitMs ?? 15000;
  const pollMs = 1000;
  const startedAt = Date.now();

  while (true) {
    const states = await Promise.all(
      searchIds.map((id) => getSearch(id).catch(() => null))
    );
    const validStates = states.filter((s): s is SlskdSearchState => s !== null);
    const allSettled = validStates.length > 0 && validStates.every(isSearchComplete);

    const responseSets = await Promise.all(
      searchIds.map((id) => getSearchResponses(id).catch(() => []))
    );
    const responses = responseSets.flat();
    const audioDirs = countAudioDirectories(responses);

    if (audioDirs > 0 || allSettled || Date.now() - startedAt >= waitMs) {
      const diag = buildDiagnostics(responses, validStates, Date.now() - startedAt);
      return { responses, diagnostics: diag };
    }

    await sleep(pollMs);
  }
}

const AUDIO_EXTS = new Set([
  ".flac", ".mp3", ".m4a", ".aac", ".alac", ".ogg", ".opus", ".wav", ".ape",
]);

const LRC_EXT = ".lrc";

function countLrcDirectories(responses: SlskdSearchResponse[]): number {
  const dirs = new Set<string>();
  for (const r of responses) {
    for (const f of r.files) {
      const lastDot = f.filename.lastIndexOf(".");
      if (lastDot !== -1) {
        const ext = f.filename.slice(lastDot).toLowerCase();
        if (ext === LRC_EXT) {
          const normalized = f.filename.replace(/\\/g, "/");
          const lastSlash = normalized.lastIndexOf("/");
          const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
          dirs.add(`${r.username}::${dir}`);
        }
      }
    }
  }
  return dirs.size;
}

function countAudioDirectories(responses: SlskdSearchResponse[]): number {
  const dirs = new Set<string>();
  for (const r of responses) {
    for (const f of r.files) {
      const lastDot = f.filename.lastIndexOf(".");
      if (lastDot !== -1) {
        const ext = f.filename.slice(lastDot).toLowerCase();
        if (AUDIO_EXTS.has(ext)) {
          const normalized = f.filename.replace(/\\/g, "/");
          const lastSlash = normalized.lastIndexOf("/");
          const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
          dirs.add(`${dir}`);
        }
      }
    }
  }
  return dirs.size;
}

function buildDiagnostics(
  responses: SlskdSearchResponse[],
  states: SlskdSearchState[],
  collectionMs: number
): SearchCollectionDiagnostics {
  const peers = new Set<string>();
  const directories = new Set<string>();
  let rawFileCount = 0;
  let lockedFileCount = 0;

  for (const r of responses) {
    peers.add(r.username);
    rawFileCount += r.files.length;
    lockedFileCount += r.lockedFileCount;
    for (const f of r.files) {
      const normalized = f.filename.replace(/\\/g, "/");
      const lastSlash = normalized.lastIndexOf("/");
      if (lastSlash >= 0) directories.add(`${r.username}::${normalized.slice(0, lastSlash)}`);
    }
  }

  const audioDirs = countAudioDirectories(responses);
  const lrcDirs = countLrcDirectories(responses);

  return {
    rawFileCount,
    lockedFileCount,
    peerResponseCount: responses.length,
    uniquePeers: peers.size,
    uniqueDirectories: directories.size,
    audioDirectories: audioDirs,
    lrcDirectories: lrcDirs,
    searchStates: states.map((s) => ({
      id: s.id,
      state: s.state,
      isComplete: isSearchComplete(s),
      fileCount: s.fileCount,
    })),
    collectionMs,
    settled: states.length > 0 && states.every(isSearchComplete),
  };
}
