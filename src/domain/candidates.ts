import type { SlskdSearchResponse, SlskdFile } from "../types/upstream";
import type { FileKind } from "../types/api";
import { normalizeFileStem } from "./normalization";

export interface CandidateFile {
  filename: string;
  size: number;
  kind: FileKind;
  extension: string;
}

export interface RawCandidate {
  peer: string;
  directory: string;
  files: CandidateFile[];
  uploadSpeed: number;
  freeUploadSlots: boolean;
  queueLength: number;
}

const AUDIO_EXTENSIONS = new Set([
  ".flac", ".mp3", ".m4a", ".aac", ".alac", ".ogg", ".opus", ".wav", ".ape",
]);

const LYRICS_EXTENSIONS = new Set([".lrc"]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const SIDECAR_EXTENSIONS = new Set([".cue", ".log", ".nfo"]);

export function classifyFile(filename: string): { kind: FileKind; extension: string } {
  const ext = getExtension(filename);

  if (AUDIO_EXTENSIONS.has(ext)) return { kind: "audio", extension: ext };
  if (LYRICS_EXTENSIONS.has(ext)) return { kind: "lyrics", extension: ext };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image", extension: ext };
  if (ext === ".cue") return { kind: "cue", extension: ext };
  if (ext === ".log") return { kind: "log", extension: ext };
  if (SIDECAR_EXTENSIONS.has(ext)) return { kind: "sidecar", extension: ext };

  // .txt might be lyrics if it has a matching audio stem
  if (ext === ".txt") return { kind: "lyrics", extension: ext };

  return { kind: "other", extension: ext };
}

export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filename.slice(lastDot).toLowerCase();
}

export function getParentDirectory(filepath: string): string {
  // Handle both / and \ path separators (Soulseek often uses Windows paths)
  const normalized = filepath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return normalized.slice(0, lastSlash);
}

export function getFilename(filepath: string): string {
  const normalized = filepath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return normalized.slice(lastSlash + 1);
}

export function groupByDirectory(
  responses: SlskdSearchResponse[]
): RawCandidate[] {
  const groups = new Map<string, RawCandidate>();

  for (const response of responses) {
    for (const file of response.files) {
      const dir = getParentDirectory(file.filename);
      const key = `${response.username}::${dir}`;

      let group = groups.get(key);
      if (!group) {
        group = {
          peer: response.username,
          directory: dir,
          files: [],
          uploadSpeed: response.uploadSpeed,
          freeUploadSlots: response.freeUploadSlots > 0,
          queueLength: response.queueLength,
        };
        groups.set(key, group);
      }

      // Multiple query variants can hit the same peer/file — keep one entry
      if (group.files.some((f) => f.filename === file.filename)) {
        continue;
      }

      const fname = getFilename(file.filename);
      const { kind, extension } = classifyFile(fname);
      group.files.push({
        filename: file.filename,
        size: file.size,
        kind,
        extension,
      });
    }
  }

  return Array.from(groups.values());
}

export interface CandidateStats {
  audioFileCount: number;
  trackCount: number;
  lrcCount: number;
  matchingLrcCount: number;
  lrcCoverage: number;
  imageCount: number;
  sidecarCount: number;
  totalBytes: number;
  dominantFormat: string;
  audioFormats: string[];
  hasCover: boolean;
}

export function computeStats(files: CandidateFile[]): CandidateStats {
  const audioFiles = files.filter((f) => f.kind === "audio");
  const lrcFiles = files.filter((f) => f.kind === "lyrics" && f.extension === ".lrc");
  const imageFiles = files.filter((f) => f.kind === "image");
  const sidecarFiles = files.filter(
    (f) => f.kind === "cue" || f.kind === "log" || f.kind === "sidecar"
  );

  // Count audio format distribution
  const formatCounts = new Map<string, number>();
  for (const f of audioFiles) {
    const ext = f.extension.replace(".", "").toUpperCase();
    formatCounts.set(ext, (formatCounts.get(ext) ?? 0) + 1);
  }

  let dominantFormat = "UNKNOWN";
  let maxCount = 0;
  for (const [fmt, count] of formatCounts) {
    if (count > maxCount) {
      dominantFormat = fmt;
      maxCount = count;
    }
  }

  // LRC coverage: match LRC stems to audio stems
  const audioStems = new Set(audioFiles.map((f) => normalizeFileStem(getFilename(f.filename))));
  let matchingLrcCount = 0;
  for (const lrc of lrcFiles) {
    const stem = normalizeFileStem(getFilename(lrc.filename));
    if (audioStems.has(stem)) {
      matchingLrcCount++;
    }
  }

  const lrcCoverage = audioFiles.length > 0 ? matchingLrcCount / audioFiles.length : 0;

  const hasCover = imageFiles.some((f) => {
    const name = getFilename(f.filename).toLowerCase();
    return (
      name.includes("cover") ||
      name.includes("folder") ||
      name.includes("front") ||
      name.includes("album")
    );
  }) || imageFiles.length > 0;

  return {
    audioFileCount: audioFiles.length,
    trackCount: audioFiles.length,
    lrcCount: lrcFiles.length,
    matchingLrcCount,
    lrcCoverage,
    imageCount: imageFiles.length,
    sidecarCount: sidecarFiles.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    dominantFormat,
    audioFormats: Array.from(formatCounts.keys()),
    hasCover,
  };
}

export function buildDisplayRelease(
  directory: string,
  artist?: string,
  title?: string
): string {
  // Try to extract a clean release name from the directory path
  const dirName = getFilename(directory) || directory;

  // If we have artist + title from the query, construct a display name
  if (artist && title) {
    return `${artist} - ${title}`;
  }

  // Clean up directory name
  return dirName.replace(/\\/g, "/").replace(/\/$/, "");
}

export function selectDownloadFiles(files: CandidateFile[]): CandidateFile[] {
  // Select: audio, matching LRC, cover images, cue, log — deduped by remote path
  const audioFiles = dedupeByFilename(files.filter((f) => f.kind === "audio"));
  const audioStems = new Set(
    audioFiles.map((f) => normalizeFileStem(getFilename(f.filename)))
  );

  const selected: CandidateFile[] = [...audioFiles];
  const seen = new Set(audioFiles.map((f) => f.filename));

  // Matching lyrics
  for (const f of files) {
    if (f.kind === "lyrics" && f.extension === ".lrc") {
      const stem = normalizeFileStem(getFilename(f.filename));
      if (audioStems.has(stem) && !seen.has(f.filename)) {
        selected.push(f);
        seen.add(f.filename);
      }
    }
  }

  // Images (covers)
  for (const f of files) {
    if (f.kind === "image" && !seen.has(f.filename)) {
      selected.push(f);
      seen.add(f.filename);
    }
  }

  // Cue/log sidecars
  for (const f of files) {
    if ((f.kind === "cue" || f.kind === "log") && !seen.has(f.filename)) {
      selected.push(f);
      seen.add(f.filename);
    }
  }

  return selected;
}

function dedupeByFilename(files: CandidateFile[]): CandidateFile[] {
  const seen = new Set<string>();
  const out: CandidateFile[] = [];
  for (const f of files) {
    if (seen.has(f.filename)) continue;
    seen.add(f.filename);
    out.push(f);
  }
  return out;
}
