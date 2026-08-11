import type { CandidateFlagName } from "../types/api";

// Word-boundary-aware detection for sensitive flags
const LIVE_PATTERNS = [
  /\blive\b/i,
  /\bconcert\b/i,
  /\blive at\b/i,
  /\blive in\b/i,
  /\baudience recording\b/i,
  /\blivesession\b/i,
];

const BOOTLEG_PATTERNS = [/\bbootleg\b/i, /\bunofficial\b/i];

const REMIX_PATTERNS = [/\bremix(es|ed)?\b/i, /\brmx\b/i];

const INSTRUMENTAL_PATTERNS = [/\binstrumental(s)?\b/i, /\binst\b/i];

const KARAOKE_PATTERNS = [/\bkaraoke\b/i, /\bkaroke\b/i];

const VINYL_RIP_PATTERNS = [/\bvinyl\s*rip\b/i, /\bvinyl\b/i];

const WEB_PATTERNS = [/\bweb\b/i, /\bweb-dl\b/i, /\bdigital\b/i];

const DELUXE_PATTERNS = [/\bdeluxe\b/i];
const EXPANDED_PATTERNS = [/\bexpanded\b/i];
const ANNIVERSARY_PATTERNS = [/\banniversary\b/i];
const REMASTER_PATTERNS = [/\bremaster(ed)?\b/i];

export interface DirectoryContext {
  directoryName: string;
  filenames: string[];
  audioFormats: string[];
  audioFileCount: number;
  lrcCount: number;
  freeUploadSlots: boolean;
  uploadSpeed: number;
  queueLength: number;
}

export function detectFlags(ctx: DirectoryContext): CandidateFlagName[] {
  const flags: CandidateFlagName[] = [];
  const dirAndFiles = `${ctx.directoryName} ${ctx.filenames.join(" ")}`;

  // Format flags
  const uniqueFormats = new Set(ctx.audioFormats.map((f) => f.toLowerCase()));
  const hasLossless = uniqueFormats.has("flac") || uniqueFormats.has("alac") || uniqueFormats.has("ape") || uniqueFormats.has("wav");
  const hasLossy = uniqueFormats.has("mp3") || uniqueFormats.has("m4a") || uniqueFormats.has("aac") || uniqueFormats.has("ogg") || uniqueFormats.has("opus");

  if (hasLossless && !hasLossy) flags.push("lossless");
  if (hasLossy && !hasLossless) flags.push("lossy");
  if (hasLossless && hasLossy) flags.push("mixed_formats");
  if (uniqueFormats.size > 1 && !flags.includes("mixed_formats")) {
    flags.push("mixed_formats");
  }

  // LRC flags
  if (ctx.lrcCount > 0 && ctx.audioFileCount > 0) {
    const coverage = ctx.lrcCount / ctx.audioFileCount;
    if (coverage >= 1.0) flags.push("complete_lrc");
    else if (coverage > 0) flags.push("partial_lrc");
  }

  // Content flags - use word boundaries to avoid false positives
  if (matchesAny(ctx.directoryName, LIVE_PATTERNS)) flags.push("live");
  if (matchesAny(ctx.directoryName, BOOTLEG_PATTERNS)) flags.push("bootleg");
  if (matchesAny(ctx.directoryName, REMIX_PATTERNS)) flags.push("remix");
  if (matchesAny(ctx.directoryName, INSTRUMENTAL_PATTERNS)) flags.push("instrumental");
  if (matchesAny(dirAndFiles, KARAOKE_PATTERNS)) flags.push("karaoke");
  if (matchesAny(ctx.directoryName, VINYL_RIP_PATTERNS)) flags.push("vinyl_rip");
  if (matchesAny(ctx.directoryName, WEB_PATTERNS)) flags.push("web");
  if (matchesAny(ctx.directoryName, DELUXE_PATTERNS)) flags.push("deluxe");
  if (matchesAny(ctx.directoryName, EXPANDED_PATTERNS)) flags.push("expanded");
  if (matchesAny(ctx.directoryName, ANNIVERSARY_PATTERNS)) flags.push("anniversary");
  if (matchesAny(ctx.directoryName, REMASTER_PATTERNS)) flags.push("remaster");

  // Peer flags
  if (!ctx.freeUploadSlots) flags.push("no_free_slot");
  if (ctx.uploadSpeed > 0 && ctx.uploadSpeed < 100000) flags.push("slow_peer");
  if (ctx.queueLength > 50) flags.push("long_queue");

  return flags;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}
