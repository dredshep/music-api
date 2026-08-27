import { createHash } from "node:crypto";
import * as lastfm from "./lastfm";
import * as navidrome from "./navidrome";
import { normalizeForComparison } from "../domain/normalization";
import {
  addFeedback,
  createGeneration,
  createStation,
  DEFAULT_RADIO_SETTINGS,
  finishGeneration,
  getGeneration,
  getGenerationTracks,
  getSeeds,
  getStation,
  listFeedback,
  listGenerations,
  listStations,
  parseRadioSettings,
  replaceGenerationTracks,
  snapshotGeneration,
  updateStation,
  updateTrackPin,
  deleteGenerationTrack,
  deleteStation,
  type RadioFeedbackAction,
  type RadioSeedInput,
  type RadioSettings,
  type RadioStationType,
  type RadioTrackRow,
} from "../db/repositories/radio";

export interface TasteTrack {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  isrc?: string | null;
  spotifyId?: string | null;
  weight?: number;
}

export interface CreateRadioInput {
  name: string;
  type?: RadioStationType;
  seeds: RadioSeedInput[];
  settings?: Partial<RadioSettings>;
  tasteProfile?: TasteTrack[];
  generate?: boolean;
}

interface Candidate {
  key: string;
  artist: string;
  title: string;
  album: string | null;
  durationMs: number | null;
  isrc: string | null;
  spotifyId: string | null;
  navidromeId: string | null;
  musicbrainzId: string | null;
  availability: "local" | "spotify" | "unavailable" | "unknown";
  playbackSource: "navidrome" | "spotify" | null;
  providerScores: Record<string, number>;
  seedScores: Record<string, number>;
  familiarity: number;
  selectionScore: number;
  metadata: Record<string, unknown>;
}

function canonicalKey(artist: string, title: string, isrc?: string | null, mbid?: string | null): string {
  if (isrc) return `isrc:${isrc.toUpperCase()}`;
  if (mbid) return `mbid:${mbid}`;
  return `text:${normalizeForComparison(artist)}|${normalizeForComparison(title)}`;
}

function seededUnit(seed: string, key: string): number {
  const hex = createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16) / 0x1fffffffffffff;
}

function parseSeedMetadata(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
}

function seedTracks(raw: string | null): TasteTrack[] {
  const metadata = parseSeedMetadata(raw);
  return Array.isArray(metadata.tracks) ? metadata.tracks.filter((x): x is TasteTrack => {
    if (!x || typeof x !== "object") return false;
    const row = x as Record<string, unknown>;
    return typeof row.artist === "string" && typeof row.title === "string";
  }) as TasteTrack[] : [];
}

function upsertCandidate(map: Map<string, Candidate>, input: {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  isrc?: string | null;
  spotifyId?: string | null;
  mbid?: string | null;
  provider: string;
  providerScore: number;
  seedId: string;
  seedScore: number;
  familiarity?: number;
  metadata?: Record<string, unknown>;
}): void {
  if (!input.artist.trim() || !input.title.trim()) return;
  const key = canonicalKey(input.artist, input.title, input.isrc, input.mbid);
  const current = map.get(key) ?? {
    key,
    artist: input.artist,
    title: input.title,
    album: input.album ?? null,
    durationMs: input.durationMs ?? null,
    isrc: input.isrc ?? null,
    spotifyId: input.spotifyId ?? null,
    navidromeId: null,
    musicbrainzId: input.mbid ?? null,
    availability: input.spotifyId ? "spotify" as const : "unknown" as const,
    playbackSource: input.spotifyId ? "spotify" as const : null,
    providerScores: {},
    seedScores: {},
    familiarity: input.familiarity ?? 0,
    selectionScore: 0,
    metadata: input.metadata ?? {},
  };
  current.providerScores[input.provider] = Math.max(current.providerScores[input.provider] ?? 0, input.providerScore);
  current.seedScores[input.seedId] = Math.max(current.seedScores[input.seedId] ?? 0, input.seedScore);
  current.familiarity = Math.max(current.familiarity, input.familiarity ?? 0);
  if (!current.spotifyId && input.spotifyId) { current.spotifyId = input.spotifyId; current.availability = "spotify"; current.playbackSource = "spotify"; }
  if (!current.isrc && input.isrc) current.isrc = input.isrc;
  if (!current.musicbrainzId && input.mbid) current.musicbrainzId = input.mbid;
  if (!current.album && input.album) current.album = input.album;
  if (!current.durationMs && input.durationMs) current.durationMs = input.durationMs;
  current.metadata = { ...current.metadata, ...(input.metadata ?? {}) };
  map.set(key, current);
}

async function collectSeedCandidates(seed: ReturnType<typeof getSeeds>[number], map: Map<string, Candidate>, errors: string[]): Promise<void> {
  const weight = Math.max(0.01, seed.weight);
  const addLastFm = (track: lastfm.LastFmTrack, provider: string, score = track.match) => upsertCandidate(map, {
    artist: track.artist,
    title: track.name,
    mbid: track.mbid || null,
    provider,
    providerScore: Math.max(0, Math.min(1, score)),
    seedId: seed.id,
    seedScore: weight * Math.max(0.05, score),
    metadata: { lastfmUrl: track.url, playcount: track.playcount },
  });

  try {
    if (seed.seed_type === "track" && seed.artist && seed.title) {
      upsertCandidate(map, { artist: seed.artist, title: seed.title, provider: "seed", providerScore: 1, seedId: seed.id, seedScore: weight, familiarity: 1 });
      (await lastfm.getSimilarTracks(seed.artist, seed.title, 60)).forEach((t) => addLastFm(t, "lastfm_similar"));
      return;
    }

    if (seed.seed_type === "artist" && seed.artist) {
      (await lastfm.getArtistTopTracks(seed.artist, 25)).forEach((t) => addLastFm(t, "lastfm_artist", Math.max(0.35, t.match)));
      const similar = await lastfm.getSimilarArtists(seed.artist, 18);
      for (const artist of similar.slice(0, 12)) {
        try {
          const tracks = await lastfm.getArtistTopTracks(artist.name, 6);
          tracks.forEach((t) => addLastFm(t, "lastfm_similar", Math.max(0.05, artist.match * Math.max(0.25, t.match))));
        } catch { /* provider-level partial failure */ }
      }
      return;
    }

    if (seed.seed_type === "album" && seed.artist && (seed.title || seed.label)) {
      const album = seed.title || seed.label;
      const tracks = await lastfm.getAlbumTracks(seed.artist, album);
      tracks.forEach((t) => addLastFm(t, "lastfm_album", Math.max(0.5, t.match)));
      for (const track of tracks.slice(0, 5)) {
        try { (await lastfm.getSimilarTracks(track.artist, track.name, 12)).forEach((t) => addLastFm(t, "lastfm_similar")); } catch { /* partial */ }
      }
      return;
    }

    if (seed.seed_type === "genre") {
      (await lastfm.getTagTopTracks(seed.label, 80)).forEach((t) => addLastFm(t, "lastfm_tag"));
      return;
    }

    const supplied = seedTracks(seed.metadata_json);
    if (supplied.length) {
      supplied.forEach((track) => upsertCandidate(map, {
        artist: track.artist,
        title: track.title,
        album: track.album,
        durationMs: track.durationMs,
        isrc: track.isrc,
        spotifyId: track.spotifyId,
        provider: "spotify_taste",
        providerScore: track.weight ?? 1,
        seedId: seed.id,
        seedScore: weight * (track.weight ?? 1),
        familiarity: 1,
      }));
      for (const track of supplied.slice(0, 16)) {
        try { (await lastfm.getSimilarTracks(track.artist, track.title, 8)).forEach((t) => addLastFm(t, "lastfm_similar")); } catch { /* partial */ }
      }
    }
  } catch (error) {
    errors.push(`${seed.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function buildTasteMaps(tasteProfile: TasteTrack[] = []) {
  const recent = await lastfm.getUserTopTracks("1month", 150).catch(() => []);
  const historical = await lastfm.getUserTopTracks("overall", 250).catch(() => []);
  const map = new Map<string, { recent: number; historical: number; spotify: number }>();
  for (const t of historical) map.set(canonicalKey(t.artist, t.name, null, t.mbid), { recent: 0, historical: t.match, spotify: 0 });
  for (const t of recent) {
    const key = canonicalKey(t.artist, t.name, null, t.mbid);
    const row = map.get(key) ?? { recent: 0, historical: 0, spotify: 0 };
    row.recent = t.match; map.set(key, row);
  }
  for (const t of tasteProfile) {
    const key = canonicalKey(t.artist, t.title, t.isrc, null);
    const row = map.get(key) ?? { recent: 0, historical: 0, spotify: 0 };
    row.spotify = t.weight ?? 1; map.set(key, row);
  }
  return map;
}

async function resolveAvailability(candidates: Candidate[]): Promise<void> {
  const batch = candidates.slice(0, 350);
  for (let i = 0; i < batch.length; i += 12) {
    await Promise.all(batch.slice(i, i + 12).map(async (candidate) => {
      try {
        const query = `${candidate.artist} ${candidate.title}`;
        const result = await navidrome.search3(query, { artistCount: 0, albumCount: 0, songCount: 8 });
        const best = result.songs.find((song) =>
          normalizeForComparison(song.artist) === normalizeForComparison(candidate.artist) &&
          normalizeForComparison(song.title) === normalizeForComparison(candidate.title)
        );
        if (best) {
          candidate.navidromeId = best.id;
          candidate.album ||= best.album;
          candidate.durationMs ||= Math.round(best.duration * 1000);
          candidate.availability = "local";
          candidate.playbackSource = "navidrome";
        } else if (candidate.spotifyId) {
          candidate.availability = "spotify";
          candidate.playbackSource = "spotify";
        } else {
          candidate.availability = "unavailable";
          candidate.playbackSource = null;
        }
      } catch {
        if (!candidate.spotifyId) candidate.availability = "unknown";
      }
    }));
  }
}

function targetSeedWeights(seeds: ReturnType<typeof getSeeds>, t: number): Record<string, number> {
  if (seeds.length === 1) return { [seeds[0]!.id]: 1 };
  const positions = seeds.map((seed, index) => {
    const raw = seed.position == null ? index / Math.max(1, seeds.length - 1) : seed.position;
    return { id: seed.id, pos: raw > 1 ? raw / Math.max(1, seeds.length - 1) : raw, weight: seed.weight };
  });
  const values: Record<string, number> = {};
  let total = 0;
  for (const row of positions) {
    const distance = Math.abs(t - row.pos);
    const value = row.weight / Math.max(0.08, distance + 0.08);
    values[row.id] = value; total += value;
  }
  for (const key of Object.keys(values)) values[key] = values[key]! / Math.max(0.0001, total);
  return values;
}

function feedbackAdjustment(candidate: Candidate, feedback: ReturnType<typeof listFeedback>): { banned: boolean; score: number } {
  let score = 0;
  for (const row of feedback) {
    const matchTrack = row.entity_type === "track" && row.entity_key === candidate.key;
    const matchArtist = row.entity_type === "artist" && normalizeForComparison(row.entity_key) === normalizeForComparison(candidate.artist);
    if (!matchTrack && !matchArtist) continue;
    if (["ban_station", "ban_track_global", "ban_artist_global"].includes(row.action)) return { banned: true, score: -100 };
    if (row.action === "more_like") score += 0.35 * row.strength;
    if (row.action === "less_like") score -= 0.35 * row.strength;
    if (row.action === "rank_down_global") score -= 0.5 * row.strength;
  }
  return { banned: false, score };
}

function scoreCandidates(candidates: Candidate[], settings: RadioSettings, seeds: ReturnType<typeof getSeeds>, tasteMap: Map<string, { recent: number; historical: number; spotify: number }>, feedback: ReturnType<typeof listFeedback>, randomSeed: string): Candidate[] {
  const seedArtists = new Set(seeds.map((s) => normalizeForComparison(s.artist ?? "")).filter(Boolean));
  for (const candidate of candidates) {
    const f = feedbackAdjustment(candidate, feedback);
    if (f.banned) { candidate.selectionScore = -999; continue; }
    const taste = tasteMap.get(candidate.key) ?? { recent: 0, historical: 0, spotify: 0 };
    const provider = Object.entries(candidate.providerScores).reduce((sum, [name, value]) => sum + value * (settings.providerWeights[name] ?? 0.55), 0);
    const seed = Object.values(candidate.seedScores).reduce((a, b) => a + b, 0);
    const familiar = Math.max(candidate.familiarity, taste.spotify, taste.recent, taste.historical * 0.8);
    candidate.familiarity = familiar;
    const familiarityPreference = (settings.familiarity - 0.5) * 2;
    const familiarityScore = familiarityPreference >= 0 ? familiar * familiarityPreference : (1 - familiar) * -familiarityPreference;
    const knownScore = settings.knownBias >= 0 ? familiar * settings.knownBias : (1 - familiar) * -settings.knownBias;
    const owned = candidate.availability === "local" ? 1 : 0;
    const ownedScore = settings.ownedBias >= 0 ? owned * settings.ownedBias : (1 - owned) * -settings.ownedBias;
    const sameArtist = seedArtists.has(normalizeForComparison(candidate.artist)) ? settings.sameArtistBias : 0;
    const tasteScore = taste.spotify * settings.providerWeights.spotify_taste + taste.recent * settings.providerWeights.lastfm_recent + taste.historical * settings.providerWeights.lastfm_history;
    const surprise = seededUnit(randomSeed, candidate.key) * settings.surprise;
    candidate.selectionScore = provider + seed * 1.4 + tasteScore + familiarityScore + knownScore + ownedScore + sameArtist + f.score + surprise;
  }
  return candidates.filter((c) => c.selectionScore > -100).sort((a, b) => b.selectionScore - a.selectionScore);
}

function transitionScore(a: Candidate | null, b: Candidate, settings: RadioSettings): number {
  if (!a) return 0;
  let score = 0;
  if (normalizeForComparison(a.artist) === normalizeForComparison(b.artist)) score -= settings.repeatStrength * 0.5;
  if (a.album && b.album && normalizeForComparison(a.album) === normalizeForComparison(b.album)) score -= 0.12;
  const aMeta = a.metadata as { bpm?: number; energy?: number; key?: string };
  const bMeta = b.metadata as { bpm?: number; energy?: number; key?: string };
  if (aMeta.bpm && bMeta.bpm) score += Math.max(0, 1 - Math.abs(aMeta.bpm - bMeta.bpm) / 60) * settings.djWeights.tempo;
  if (aMeta.energy != null && bMeta.energy != null) score += Math.max(0, 1 - Math.abs(aMeta.energy - bMeta.energy)) * settings.djWeights.energy;
  if (aMeta.key && bMeta.key && aMeta.key === bMeta.key) score += settings.djWeights.key;
  return score * settings.djFlow;
}

function selectSequence(scored: Candidate[], length: number, settings: RadioSettings, seeds: ReturnType<typeof getSeeds>, stationType: RadioStationType, randomSeed: string): Candidate[] {
  const selected: Candidate[] = [];
  const used = new Set<string>();
  const artistLast = new Map<string, number>();
  for (let position = 0; position < length && used.size < scored.length; position++) {
    const t = length <= 1 ? 0 : position / (length - 1);
    const targets = stationType === "gradient" ? targetSeedWeights(seeds, t) : null;
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const candidate of scored.slice(0, Math.max(120, length * 8))) {
      if (used.has(candidate.key)) continue;
      const artistKey = normalizeForComparison(candidate.artist);
      const last = artistLast.get(artistKey);
      let repeatPenalty = 0;
      if (last != null) {
        const gap = position - last;
        repeatPenalty = Math.max(0, (settings.artistCooldown - gap + 1) / Math.max(1, settings.artistCooldown)) * settings.repeatStrength;
      }
      const trajectory = targets ? Object.entries(targets).reduce((sum, [seedId, weight]) => sum + (candidate.seedScores[seedId] ?? 0) * weight, 0) * 2 : 0;
      const previous = selected.at(-1) ?? null;
      const flow = transitionScore(previous, candidate, settings);
      const jitter = seededUnit(randomSeed, `${position}:${candidate.key}`) * 0.025;
      const score = candidate.selectionScore + trajectory + flow - repeatPenalty + jitter;
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best) break;
    used.add(best.key);
    artistLast.set(normalizeForComparison(best.artist), position);
    selected.push({ ...best, selectionScore: bestScore, metadata: { ...best.metadata, trajectoryTarget: stationType === "gradient" ? t : null } });
  }
  return selected;
}

async function generateCandidates(stationId: string, settings: RadioSettings, tasteProfile: TasteTrack[] | undefined, randomSeed: string) {
  const seeds = getSeeds(stationId);
  const errors: string[] = [];
  const map = new Map<string, Candidate>();
  for (const seed of seeds) await collectSeedCandidates(seed, map, errors);
  const tasteMap = await buildTasteMaps(tasteProfile);
  for (const track of tasteProfile ?? []) {
    const key = canonicalKey(track.artist, track.title, track.isrc, null);
    const existing = map.get(key);
    if (existing) {
      existing.spotifyId ||= track.spotifyId ?? null;
      existing.isrc ||= track.isrc ?? null;
      existing.familiarity = Math.max(existing.familiarity, track.weight ?? 1);
    }
  }
  const candidates = [...map.values()];
  await resolveAvailability(candidates);
  const feedback = listFeedback(stationId);
  return { scored: scoreCandidates(candidates, settings, seeds, tasteMap, feedback, randomSeed), seeds, errors };
}

function toStoredTrack(candidate: Candidate, trajectory: number | null): Omit<RadioTrackRow, "id" | "generation_id" | "created_at" | "position"> {
  return {
    canonical_key: candidate.key,
    artist: candidate.artist,
    title: candidate.title,
    album: candidate.album,
    duration_ms: candidate.durationMs,
    isrc: candidate.isrc,
    spotify_id: candidate.spotifyId,
    navidrome_id: candidate.navidromeId,
    musicbrainz_id: candidate.musicbrainzId,
    playback_source: candidate.playbackSource,
    availability_status: candidate.availability,
    pinned: 0,
    manual: 0,
    selection_score: candidate.selectionScore,
    trajectory_position: trajectory,
    metadata_json: JSON.stringify(candidate.metadata),
  };
}

export async function createRadio(input: CreateRadioInput) {
  if (!input.seeds.length) throw new Error("Radio requires at least one seed");
  const seeds = input.seeds.map((seed, index) => ({ ...seed, position: input.type === "gradient" ? (seed.position ?? index / Math.max(1, input.seeds.length - 1)) : seed.position }));
  const station = createStation({ name: input.name, type: input.type, settings: input.settings, seeds });
  const generation = input.generate === false ? null : await generateStation(station.id, { tasteProfile: input.tasteProfile });
  return { station: presentStation(station.id), generation };
}

export function presentStation(stationId: string) {
  const station = getStation(stationId);
  if (!station) return null;
  return {
    id: station.id,
    name: station.name,
    type: station.type,
    settings: parseRadioSettings(station.settings_json),
    seeds: getSeeds(station.id).map((seed) => ({
      id: seed.id, type: seed.seed_type, entity_id: seed.entity_id, artist: seed.artist, title: seed.title,
      label: seed.label, weight: seed.weight, position: seed.position, metadata: parseSeedMetadata(seed.metadata_json),
    })),
    generations: listGenerations(station.id).map((g) => ({ id: g.id, revision: g.revision, status: g.status, requested_length: g.requested_length, created_at: g.created_at, completed_at: g.completed_at })),
    created_at: station.created_at,
    updated_at: station.updated_at,
  };
}

export function presentGeneration(generationId: string) {
  const generation = getGeneration(generationId);
  if (!generation) return null;
  return {
    id: generation.id,
    station_id: generation.station_id,
    revision: generation.revision,
    status: generation.status,
    requested_length: generation.requested_length,
    generator_version: generation.generator_version,
    random_seed: generation.random_seed,
    settings: parseRadioSettings(generation.settings_snapshot_json),
    diagnostics: generation.diagnostics_json ? JSON.parse(generation.diagnostics_json) : null,
    created_at: generation.created_at,
    completed_at: generation.completed_at,
    tracks: getGenerationTracks(generationId).map((track) => ({
      id: track.id,
      position: track.position,
      canonical_key: track.canonical_key,
      artist: track.artist,
      title: track.title,
      album: track.album,
      duration_ms: track.duration_ms,
      isrc: track.isrc,
      spotify_id: track.spotify_id,
      navidrome_id: track.navidrome_id,
      musicbrainz_id: track.musicbrainz_id,
      playback_source: track.playback_source,
      availability: track.availability_status,
      pinned: Boolean(track.pinned),
      manual: Boolean(track.manual),
      score: track.selection_score,
      trajectory_position: track.trajectory_position,
      metadata: track.metadata_json ? JSON.parse(track.metadata_json) : null,
    })),
  };
}

export function listRadioStations() { return listStations().map((s) => presentStation(s.id)!); }

export async function generateStation(stationId: string, input: { length?: number; tasteProfile?: TasteTrack[] } = {}) {
  const station = getStation(stationId);
  if (!station) throw new Error("Radio station not found");
  const settings = parseRadioSettings(station.settings_json);
  const length = Math.max(1, Math.min(200, input.length ?? settings.length ?? station.default_length));
  const randomSeed = crypto.randomUUID();
  const generation = createGeneration({ stationId, requestedLength: length, generatorVersion: "radio-v1", randomSeed, settingsSnapshot: { ...settings, length } });
  const started = performance.now();
  try {
    const { scored, seeds, errors } = await generateCandidates(stationId, settings, input.tasteProfile, randomSeed);
    const sequence = selectSequence(scored, length, settings, seeds, station.type, randomSeed);
    const tracks = sequence.map((candidate, index) => toStoredTrack(candidate, station.type === "gradient" ? (length <= 1 ? 0 : index / (length - 1)) : null));
    replaceGenerationTracks(generation.id, tracks);
    finishGeneration(generation.id, sequence.length >= Math.min(length, 3) ? (errors.length ? "partial" : "ready") : "partial", {
      candidate_count: scored.length,
      selected_count: sequence.length,
      unavailable_count: sequence.filter((c) => c.availability === "unavailable").length,
      provider_errors: errors,
      duration_ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    finishGeneration(generation.id, "failed", { error: error instanceof Error ? error.message : String(error), duration_ms: Math.round(performance.now() - started) });
  }
  return presentGeneration(generation.id)!;
}

export async function regenerateTail(generationId: string, fromPosition: number, tasteProfile?: TasteTrack[]) {
  const generation = getGeneration(generationId);
  if (!generation) throw new Error("Radio generation not found");
  const station = getStation(generation.station_id);
  if (!station) throw new Error("Radio station not found");
  const existing = getGenerationTracks(generationId);
  snapshotGeneration(generationId, `regenerate_tail:${fromPosition}`);
  const prefix = existing.filter((t) => t.position < fromPosition);
  const pinned = existing.filter((t) => t.position >= fromPosition && t.pinned);
  const settings = parseRadioSettings(generation.settings_snapshot_json);
  const randomSeed = crypto.randomUUID();
  const { scored, seeds, errors } = await generateCandidates(station.id, settings, tasteProfile, randomSeed);
  const used = new Set([...prefix, ...pinned].map((t) => t.canonical_key));
  const replacement = selectSequence(scored.filter((c) => !used.has(c.key)), generation.requested_length, settings, seeds, station.type, randomSeed);
  const byPosition = new Map<number, RadioTrackRow>();
  prefix.forEach((t) => byPosition.set(t.position, t));
  pinned.forEach((t) => byPosition.set(t.position, t));
  let cursor = 0;
  const output: Array<Omit<RadioTrackRow, "id" | "generation_id" | "created_at" | "position"> & { position?: number }> = [];
  for (let position = 0; position < generation.requested_length; position++) {
    const kept = byPosition.get(position);
    if (kept) {
      output.push({ ...kept, position, metadata_json: kept.metadata_json });
      continue;
    }
    const candidate = replacement[cursor++];
    if (!candidate) continue;
    output.push({ ...toStoredTrack(candidate, station.type === "gradient" ? (generation.requested_length <= 1 ? 0 : position / (generation.requested_length - 1)) : null), position });
  }
  replaceGenerationTracks(generationId, output);
  finishGeneration(generationId, errors.length ? "partial" : "ready", { regenerated_from: fromPosition, provider_errors: errors });
  return presentGeneration(generationId)!;
}

export function updateRadioStation(stationId: string, patch: Parameters<typeof updateStation>[1]) {
  return updateStation(stationId, patch) ? presentStation(stationId) : null;
}

export function removeRadioStation(stationId: string) { return deleteStation(stationId); }

export function recordRadioFeedback(input: { scope: "station" | "global"; stationId?: string | null; entityType: "track" | "artist"; entityKey: string; action: RadioFeedbackAction; strength?: number }) {
  return addFeedback(input);
}

export function pinGenerationTrack(generationId: string, trackId: string, pinned: boolean) {
  snapshotGeneration(generationId, pinned ? "pin" : "unpin");
  return updateTrackPin(generationId, trackId, pinned);
}

export function removeGenerationTrack(generationId: string, trackId: string) {
  snapshotGeneration(generationId, "remove_track");
  return deleteGenerationTrack(generationId, trackId);
}

export { DEFAULT_RADIO_SETTINGS };
