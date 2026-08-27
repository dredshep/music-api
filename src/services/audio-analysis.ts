import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig } from "../config";
import { getDb } from "../db/database";
import { getGenerationTracks } from "../db/repositories/radio";
import * as navidrome from "./navidrome";
import { log } from "../middleware/logging";

const execFileAsync = promisify(execFile);
const ANALYSIS_VERSION = 2;
const pending = new Map<string, { canonicalKey: string; navidromeId: string }>();
let workerRunning = false;

type AnalyzerOutput = {
  bpm?: number | null;
  key?: string | null;
  mode?: string | null;
  loudness?: number | null;
  energy?: number | null;
  timbre?: unknown;
  rhythm?: unknown;
  intro?: unknown;
  outro?: unknown;
  analysis?: unknown;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
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

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    upsertAnalysis({
      canonicalKey,
      fingerprint: null,
      status: "unavailable",
      error: `Audio file is not mounted in music-api: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
    });
    return;
  }

  const fingerprint = `${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
  const cached = getDb().query<{ status: string; source_fingerprint: string | null }, [string, number]>(
    "SELECT status,source_fingerprint FROM track_audio_analysis WHERE canonical_key=? AND analysis_version=?",
  ).get(canonicalKey, ANALYSIS_VERSION);
  if (cached?.status === "ready" && cached.source_fingerprint === fingerprint) return;

  try {
    const analyzer = path.resolve(process.cwd(), "scripts/analyze-audio.py");
    const { stdout } = await execFileAsync("python3", [analyzer, filePath], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AnalyzerOutput;
    const bpm = finite(parsed.bpm);
    const key = text(parsed.key);
    const mode = text(parsed.mode);
    const loudness = finite(parsed.loudness);
    const energy = finite(parsed.energy);

    upsertAnalysis({
      canonicalKey,
      fingerprint,
      status: "ready",
      bpm,
      key,
      mode,
      loudness,
      energy,
      timbre: json(parsed.timbre),
      rhythm: json({ ...(parsed.rhythm && typeof parsed.rhythm === "object" ? parsed.rhythm as Record<string, unknown> : {}), analysis: parsed.analysis }),
      intro: json(parsed.intro),
      outro: json(parsed.outro),
    });
    log("info", "radio_audio_analysis_ready", {
      canonical_key: canonicalKey,
      navidrome_id: navidromeId,
      bpm,
      key,
      engine: "aubio+numpy",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr.trim() : "";
    const raw = stderr || (error instanceof Error ? error.message : String(error));
    const unavailable = code === "ENOENT" || /No module named ['\"]?(aubio|numpy)/i.test(raw);
    const message = unavailable
      ? `Bundled Radio audio analyzer dependencies are unavailable: ${raw}`
      : raw;
    upsertAnalysis({ canonicalKey, fingerprint, status: unavailable ? "unavailable" : "failed", error: message.slice(0, 1000) });
    log("warn", "radio_audio_analysis_failed", { canonical_key: canonicalKey, error: message });
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
        log("warn", "radio_audio_analysis_worker_error", {
          canonical_key: job.canonicalKey,
          error: error instanceof Error ? error.message : String(error),
        });
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
  return {
    queued: tracks.length,
    pending: pending.size,
    analyzer: "aubio+numpy",
    analysis_version: ANALYSIS_VERSION,
  };
}

export function getAudioAnalysisQueueStatus() {
  return {
    running: workerRunning,
    pending: pending.size,
    analyzer: "aubio+numpy",
    analysis_version: ANALYSIS_VERSION,
  };
}
