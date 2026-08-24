import * as navidrome from "./navidrome";
import { getCachedLibraryDiskUsage } from "./library-storage";

export interface LibraryScanStatus {
  scanning: boolean;
  /** Files processed in the current scan session. Meaningful while scanning. */
  files_scanned: number;
  /** Folders processed in the current scan session. Meaningful while scanning. */
  folders_scanned: number;
  /** Indexed track count from the last idle scan status (denominator for progress). */
  library_total_tracks: number | null;
  /** Rough progress while scanning: files_scanned / library_total_tracks. Incremental scans may move slowly. */
  progress_percent: number | null;
  progress_note: string | null;
  last_scan: string | null;
  scan_type: string | null;
  elapsed_ms: number | null;
  error: string | null;
  library_disk: {
    bytes: number;
    display: string;
  } | null;
}

/** Last known library track total from Navidrome when scan was idle. */
let cachedLibraryTotalTracks: number | null = null;

export function resetScanStatusCacheForTests(): void {
  cachedLibraryTotalTracks = null;
}

export function computeScanProgress(params: {
  scanning: boolean;
  filesScanned: number;
  libraryTotalTracks: number | null;
}): { progress_percent: number | null; progress_note: string | null } {
  if (!params.scanning) {
    return { progress_percent: null, progress_note: null };
  }

  if (params.libraryTotalTracks != null && params.libraryTotalTracks > 0) {
    return {
      progress_percent: Math.min(
        99,
        Math.round((params.filesScanned / params.libraryTotalTracks) * 100)
      ),
      progress_note:
        "Approximate: current scan files vs last known library track total. Incremental scans may progress slowly.",
    };
  }

  return {
    progress_percent: null,
    progress_note:
      "Scan running but library track total unknown — poll files_scanned for activity.",
  };
}

function elapsedToMs(raw: number | undefined): number | null {
  if (raw == null || raw <= 0) return null;
  // Navidrome reports Go time.Duration; JSON values are typically nanoseconds.
  if (raw > 1_000_000_000) return Math.round(raw / 1_000_000);
  return Math.round(raw);
}

export async function getLibraryScanStatus(): Promise<LibraryScanStatus> {
  const raw = await navidrome.getScanStatus();

  if (!raw.scanning && raw.count > 0) {
    cachedLibraryTotalTracks = raw.count;
  }

  const libraryTotalTracks = raw.scanning
    ? cachedLibraryTotalTracks
    : raw.count > 0
      ? raw.count
      : cachedLibraryTotalTracks;

  let progressPercent: number | null = null;
  let progressNote: string | null = null;

  if (raw.scanning) {
    const progress = computeScanProgress({
      scanning: true,
      filesScanned: raw.count,
      libraryTotalTracks,
    });
    progressPercent = progress.progress_percent;
    progressNote = progress.progress_note;
  }

  const disk = getCachedLibraryDiskUsage();

  return {
    scanning: raw.scanning,
    files_scanned: raw.count,
    folders_scanned: raw.folderCount ?? 0,
    library_total_tracks: libraryTotalTracks,
    progress_percent: progressPercent,
    progress_note: progressNote,
    last_scan: raw.lastScan ?? null,
    scan_type: raw.scanType ?? null,
    elapsed_ms: elapsedToMs(raw.elapsedTime),
    error: raw.error?.trim() ? raw.error : null,
    library_disk: disk
      ? { bytes: disk.bytes, display: disk.display }
      : null,
  };
}
