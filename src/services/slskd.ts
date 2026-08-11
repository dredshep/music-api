import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { AppError } from "../middleware/errors";
import type {
  SlskdSearchState,
  SlskdSearchResponse,
  SlskdDownloadState,
  SlskdUserDirectory,
} from "../types/upstream";

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

/** Start multiple queries serially (slskd allows only one concurrent start). */
export async function startSearches(queries: string[]): Promise<SlskdSearchState[]> {
  const results: SlskdSearchState[] = [];
  for (const query of queries) {
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
  return slskdFetch<SlskdSearchResponse[]>(`/searches/${searchId}/responses`);
}

export async function getUserDirectory(
  username: string,
  directory?: string
): Promise<SlskdUserDirectory> {
  const params = new URLSearchParams();
  if (directory) params.set("directory", directory);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return slskdFetch<SlskdUserDirectory>(
    `/users/${encodeURIComponent(username)}/directory${qs}`
  );
}

export interface RemoteFile {
  filename: string;
  size: number;
}

export async function enqueueFiles(
  username: string,
  files: RemoteFile[]
): Promise<void> {
  // slskd rejects requests with duplicate filenames
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

export async function waitForSearchCompletion(
  searchId: string,
  timeoutMs: number
): Promise<SlskdSearchResponse[]> {
  const config = getConfig();
  const deadline = Date.now() + (timeoutMs || config.SEARCH_COLLECTION_MS);
  const pollInterval = 1000;

  while (Date.now() < deadline) {
    const state = await getSearch(searchId);
    if (
      state.state === "Completed" ||
      state.state === "completed" ||
      state.responseCount > 0
    ) {
      await new Promise((r) => setTimeout(r, Math.min(2000, deadline - Date.now())));
      break;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return getSearchResponses(searchId);
}
