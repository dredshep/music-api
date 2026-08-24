import { statSync } from "node:fs";
import { getConfig } from "../config";
import { getCache, setCache } from "../db/repositories/cache";
import { log } from "../middleware/logging";

export interface LibraryDiskUsage {
  bytes: number;
  gb: number;
  tb: number;
  display: string;
}

const DISK_CACHE_KEY = "lib:disk:size:v1";
let refreshInFlight: Promise<LibraryDiskUsage | null> | null = null;

export function formatLibraryDiskUsage(bytes: number): LibraryDiskUsage {
  const gb = bytes / 1024 ** 3;
  const tb = bytes / 1024 ** 4;
  const display =
    tb >= 1
      ? `${Math.round(tb * 100) / 100} TB`
      : `${Math.round(gb * 10) / 10} GB`;

  return {
    bytes,
    gb: Math.round(gb * 100) / 100,
    tb: Math.round(tb * 1000) / 1000,
    display,
  };
}

async function duSizeBytes(path: string): Promise<number | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["du", "-sb", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    log("warn", "library_disk_du_spawn_failed", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    log("warn", "library_disk_du_failed", {
      path,
      exit_code: exitCode,
      stderr: stderr.trim().slice(0, 200),
    });
    return null;
  }

  const stdout = (await new Response(proc.stdout).text()).trim();
  const bytes = Number.parseInt(stdout.split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(bytes) || bytes < 0) {
    log("warn", "library_disk_du_parse_failed", {
      path,
      stdout: stdout.slice(0, 80),
    });
    return null;
  }

  return bytes;
}

export function getCachedLibraryDiskUsage(): LibraryDiskUsage | null {
  return getCache<LibraryDiskUsage>(DISK_CACHE_KEY);
}

export async function refreshLibraryDiskUsage(): Promise<LibraryDiskUsage | null> {
  const path = getConfig().LIBRARY_MUSIC_PATH?.trim();
  if (!path) return null;

  try {
    const info = statSync(path);
    if (!info.isDirectory()) {
      log("warn", "library_disk_path_not_directory", { path });
      return null;
    }
  } catch {
    log("warn", "library_disk_path_unavailable", { path });
    return null;
  }

  const start = performance.now();
  const bytes = await duSizeBytes(path);
  if (bytes == null) return null;

  const usage = formatLibraryDiskUsage(bytes);
  setCache(
    DISK_CACHE_KEY,
    usage,
    getConfig().LIBRARY_DISK_CACHE_MINUTES * 60 * 1000
  );

  log("info", "library_disk_usage_computed", {
    path,
    method: "du",
    bytes,
    duration_ms: Math.round(performance.now() - start),
  });

  return usage;
}

export function scheduleLibraryDiskUsageRefresh(): void {
  if (!getConfig().LIBRARY_MUSIC_PATH?.trim()) return;
  if (getCachedLibraryDiskUsage()) return;
  if (refreshInFlight) return;

  refreshInFlight = refreshLibraryDiskUsage()
    .catch((err) => {
      log("warn", "library_disk_refresh_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });
}

export function isLibraryDiskUsageRefreshPending(): boolean {
  return refreshInFlight != null;
}

export function warmLibraryDiskUsageCache(): void {
  scheduleLibraryDiskUsageRefresh();
}
