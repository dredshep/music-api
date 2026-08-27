import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { getConfig } from "../config";
import { getDb } from "../db/database";
import { getGenerationTracks } from "../db/repositories/radio";
import * as navidrome from "./navidrome";
import { log } from "../middleware/logging";

const execFileAsync = promisify(execFile);
const ANALYSIS_VERSION = 1;
const pending = new Map<string, { canonicalKey: string; navidromeId: string }>();
let workerRunning = false;

function numberAt(root: unknown, paths: string[]): number | null {
  for (const dotted of paths) {
    let value: unknown = root;
    for (const part of dotted.split(".")) {
      if (!value || typeof value !== "object") { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function stringAt(root: unknown, paths: string[]): string | null {
  for (const dotted of paths) {
    let value: unknown = root;
    for (const part of dotted.split(".")) {
      if (!value || typeof value !== "object") { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function jsonAt(root: unknown, paths: string[]): string | null {
  for (const dotted of paths) {
    let value: unknown = root;
    for (const part of dotted.split(".")) {
      if (!value || typeof value !== "object") { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    if (value != null) return JSON.stringify(value);
  }
  return null;
}

function upsertAnalysis(input: {
  canonicalKey: string;
  fingerprint: string | null;
  status: "ready" | "failed" | "unavailable";
  bpm?: number | null;
  key?: string | null;
  mode?: string | null;
  loudness?: number | null;
  energy?: number | null;
  timbre?: string | null;
  rhythm?: string | null;
  intro?: string | null;
  outro?: string | null;
  error?: string | null;
}) {
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO track_audio_analysis (
      canonical_key,analysis_version,bpm,musical_key,mode,loudness,energy,timbre_json,rhythm_json,intro_json,outro_json,
      source_fingerprint,status,error,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(canonical_key,analysis_version) DO UPDATE SET
      bpm=excluded.bpm,musical_key=excluded.musical_key,mode=excluded.mode,loudness=excluded.loudness,energy=excluded.energy,
      timbre_json=excluded.timbre_json,rhythm_json=excluded.rhythm_json,intro_json=excluded.intro_json,outro_json=excluded.outro_json,
      source_fingerprint=excluded.source_fingerprint,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
    .run(
      input.canonicalKey,
      ANALYSIS_VERSION,
      input.bpm ?? null,
      input.key ?? null,
      input.mode ?? null,
      input.loudness ?? null,
      input.energy ?? null,
      input.timbre ?? null,
      input.rhythm ?? null,
      input.intro ?? null,
      input.outro ?? null,
      input.fingerprint,
      input.status,
      input.error ?? null,
      now,
      now,
    );
}

async function analyzeOne(canonicalKey: string, navidromeId: string) {
  const config = getConfig();
  if (!config.LIBRARY_MUSIC_PATH) {
    upsertAnalysis({ canonicalKey, fingerprint: null, status: "unavailable", error: "LIBRARY_MUSIC_PATH is not configured" });
    return;
  }

  const song = await navidrome.getSong(navidromeId);
  if (!song.path) {
    upsertAnalysis({ canonicalKey, fingerprint: null, status: "unavailable", error: "Navidrome did not expose the song path" });
    return;
  }

  const root = path.resolve(config.LIBRARY_MUSIC_PATH);
  const filePath = path.resolve(root, song.path);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    upsertAnalysis({ canonicalKey, fingerprint: null, status: "failed", error: "Resolved audio path escaped library root" });
    return;
  }

  const fileStat = await stat(filePath);
  const fingerprint = `${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
  const cached = getDb().query<{ status: string; source_fingerprint: string | null }, [string, number]>(
    "SELECT status,source_fingerprint FROM track_audio_analysis WHERE canonical_key=? AND analysis_version=?",
  ).get(canonicalKey, ANALYSIS_VERSION);
  if (cached?.status === "ready" && cached.source_fingerprint === fingerprint) return;

  const tmp = await mkdtemp(path.join(os.tmpdir(), "music-radio-analysis-"));
  const output = path.join(tmp, "analysis.json");
  try {
    await execFileAsync("essentia_streaming_extractor_music", [filePath, output], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    const bpm = numberAt(parsed, ["rhythm.bpm", "rhythm.bpm_histogram_first_peak_bpm"]);
    const key = stringAt(parsed, ["tonal.key_key", "tonal.key_edma.key", "tonal.chords_key"]);
    const mode = stringAt(parsed, ["tonal.key_scale", "tonal.key_edma.scale", "tonal.chords_scale"]);
    const loudness = numberAt(parsed, ["lowlevel.loudness_ebu128.integrated", "lowlevel.average_loudness", "lowlevel.loudness"]);
    const energyRaw = numberAt(parsed, ["rhythm.danceability", "lowlevel.dynamic_complexity", "lowlevel.spectral_energy.mean"]);
    const energy = energyRaw == null ? null : Math.max(0, Math.min(1, energyRaw > 1 ? energyRaw / 10 : energyRaw));

    upsertAnalysis({
      canonicalKey,
      fingerprint,
      status: "ready",
      bpm,
      key,
      mode,
      loudness,
      energy,
      timbre: jsonAt(parsed, ["lowlevel.mfcc.mean", "lowlevel.spectral_centroid.mean", "lowlevel"]),
      rhythm: jsonAt(parsed, ["rhythm"]),
      intro: jsonAt(parsed, ["segmentation", "metadata.audio_properties"]),
      outro: jsonAt(parsed, ["segmentation", "metadata.audio_properties"]),
    });
    log("info", "radio_audio_analysis_ready", { canonical_key: canonicalKey, navidrome_id: navidromeId, bpm, key });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = code === "ENOENT"
      ? "essentia_streaming_extractor_music is not installed"
      : error instanceof Error ? error.message : String(error);
    upsertAnalysis({ canonicalKey, fingerprint, status: code === "ENOENT" ? "unavailable" : "failed", error: message.slice(0, 1000) });
    log("warn", "radio_audio_analysis_failed", { canonical_key: canonicalKey, error: message });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (pending.size) {
      const [key, job] = pending.entries().next().value as [string, { canonicalKey: string; navidromeId: string }];
      pending.delete(key);
      await analyzeOne(job.canonicalKey, job.navidromeId).catch((error) => {
        log("warn", "radio_audio_analysis_worker_error", { canonical_key: job.canonicalKey, error: error instanceof Error ? error.message : String(error) });
      });
    }
  } finally {
    workerRunning = false;
  }
}

export function queueRadioGenerationAnalysis(generationId: string) {
  const tracks = getGenerationTracks(generationId).filter((track) => Boolean(track.navidrome_id));
  for (const track of tracks) {
    pending.set(track.canonical_key, { canonicalKey: track.canonical_key, navidromeId: track.navidrome_id! });
  }
  void runWorker();
  return { queued: tracks.length, pending: pending.size, analyzer: "essentia_streaming_extractor_music", analysis_version: ANALYSIS_VERSION };
}

export function getAudioAnalysisQueueStatus() {
  return { running: workerRunning, pending: pending.size, analysis_version: ANALYSIS_VERSION };
}
