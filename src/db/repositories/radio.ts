import { ulid } from "ulid";
import { getDb } from "../database";

export type RadioStationType = "standard" | "gradient";
export type RadioSeedType = "track" | "artist" | "album" | "genre" | "playlist" | "liked" | "library" | "collection";
export type RadioFeedbackAction = "more_like" | "less_like" | "ban_station" | "rank_down_global" | "ban_track_global" | "ban_artist_global";
export type GradientAlgorithm = "blend" | "geodesic" | "scenic";

export interface RadioSettings {
  length: number;
  familiarity: number;
  knownBias: number;
  ownedBias: number;
  sameArtistBias: number;
  popularityBias: number;
  releaseAgeBias: number;
  genreSimilarity: number;
  seedArtistFrequency: number;
  artistCooldown: number;
  trackCooldown: number;
  repeatStrength: number;
  surprise: number;
  djFlow: number;
  gradientAlgorithm: GradientAlgorithm;
  gradientRouteStrength: number;
  gradientRouteWidth: number;
  providerWeights: Record<string, number>;
  djWeights: Record<string, number>;
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  length: 30,
  familiarity: 0.55,
  knownBias: 0.15,
  ownedBias: 0,
  sameArtistBias: 0.35,
  popularityBias: -0.1,
  releaseAgeBias: 0,
  genreSimilarity: 0.75,
  seedArtistFrequency: 0.16,
  artistCooldown: 5,
  trackCooldown: 100,
  repeatStrength: 0.8,
  surprise: 0.15,
  djFlow: 0.65,
  gradientAlgorithm: "geodesic",
  gradientRouteStrength: 2.4,
  gradientRouteWidth: 0.22,
  providerWeights: {
    seed: 1.05,
    spotify_taste: 1,
    spotify_playlist: 0.95,
    navidrome_library: 0.9,
    collection_seed: 0.85,
    seed_collection: 0.85,
    lastfm_recent: 0.95,
    lastfm_history: 0.8,
    local_history: 0.7,
    lastfm_similar: 0.9,
    lastfm_artist: 0.85,
    lastfm_album: 0.85,
    lastfm_tag: 0.85,
    gradient_route: 1.05,
    listenbrainz: 0.35,
    musicbrainz: 0.25,
    internal_feedback: 0.8,
  },
  djWeights: {
    tempo: 0.2,
    key: 0.15,
    energy: 0.2,
    timbre: 0.15,
    introOutro: 0.1,
    semantic: 0.15,
    artistSpacing: 0.45,
  },
};

export interface RadioSeedInput {
  type: RadioSeedType;
  entityId?: string | null;
  artist?: string | null;
  title?: string | null;
  label: string;
  weight?: number;
  position?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface RadioStationRow {
  id: string;
  name: string;
  type: RadioStationType;
  default_length: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface RadioSeedRow {
  id: string;
  station_id: string;
  seed_type: RadioSeedType;
  entity_id: string | null;
  artist: string | null;
  title: string | null;
  label: string;
  weight: number;
  position: number | null;
  metadata_json: string | null;
  created_at: string;
}

export interface RadioGenerationRow {
  id: string;
  station_id: string;
  revision: number;
  requested_length: number;
  generator_version: string;
  random_seed: string;
  status: string;
  settings_snapshot_json: string;
  diagnostics_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RadioTrackRow {
  id: string;
  generation_id: string;
  position: number;
  canonical_key: string;
  artist: string;
  title: string;
  album: string | null;
  duration_ms: number | null;
  isrc: string | null;
  spotify_id: string | null;
  navidrome_id: string | null;
  musicbrainz_id: string | null;
  playback_source: string | null;
  availability_status: string;
  pinned: number;
  manual: number;
  selection_score: number;
  trajectory_position: number | null;
  metadata_json: string | null;
  created_at: string;
}

export interface RadioFeedbackRow {
  id: string;
  scope: string;
  station_id: string | null;
  entity_type: string;
  entity_key: string;
  action: RadioFeedbackAction;
  strength: number;
  created_at: string;
}

export function parseRadioSettings(value?: string | null): RadioSettings {
  let patch: Partial<RadioSettings> = {};
  try { if (value) patch = JSON.parse(value) as Partial<RadioSettings>; } catch { /* use defaults */ }
  return {
    ...DEFAULT_RADIO_SETTINGS,
    ...patch,
    providerWeights: { ...DEFAULT_RADIO_SETTINGS.providerWeights, ...(patch.providerWeights ?? {}) },
    djWeights: { ...DEFAULT_RADIO_SETTINGS.djWeights, ...(patch.djWeights ?? {}) },
  };
}

export function createStation(input: { name: string; type?: RadioStationType; settings?: Partial<RadioSettings>; seeds: RadioSeedInput[] }): RadioStationRow {
  const db = getDb();
  const id = `radio_${ulid()}`;
  const now = new Date().toISOString();
  const settings = { ...DEFAULT_RADIO_SETTINGS, ...(input.settings ?? {}) } as RadioSettings;
  settings.providerWeights = { ...DEFAULT_RADIO_SETTINGS.providerWeights, ...(input.settings?.providerWeights ?? {}) };
  settings.djWeights = { ...DEFAULT_RADIO_SETTINGS.djWeights, ...(input.settings?.djWeights ?? {}) };
  const type = input.type ?? "standard";

  db.transaction(() => {
    db.query(`INSERT INTO radio_stations (id,name,type,default_length,settings_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.name, type, settings.length, JSON.stringify(settings), now, now);
    const stmt = db.query(`INSERT INTO radio_station_seeds (id,station_id,seed_type,entity_id,artist,title,label,weight,position,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    input.seeds.forEach((seed, index) => stmt.run(
      `rseed_${ulid()}`, id, seed.type, seed.entityId ?? null, seed.artist ?? null, seed.title ?? null,
      seed.label, seed.weight ?? 1, seed.position ?? (type === "gradient" ? index : null),
      seed.metadata ? JSON.stringify(seed.metadata) : null, now,
    ));
  })();

  return getStation(id)!;
}

export function getStation(id: string): RadioStationRow | null {
  return getDb().query<RadioStationRow, [string]>("SELECT * FROM radio_stations WHERE id=?").get(id) ?? null;
}

export function listStations(limit = 100): RadioStationRow[] {
  return getDb().query<RadioStationRow, [number]>("SELECT * FROM radio_stations ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function getSeeds(stationId: string): RadioSeedRow[] {
  return getDb().query<RadioSeedRow, [string]>("SELECT * FROM radio_station_seeds WHERE station_id=? ORDER BY COALESCE(position, 999999), created_at").all(stationId);
}

export function updateStation(id: string, patch: { name?: string; type?: RadioStationType; settings?: Partial<RadioSettings>; seeds?: RadioSeedInput[] }): RadioStationRow | null {
  const current = getStation(id);
  if (!current) return null;
  const currentSettings = parseRadioSettings(current.settings_json);
  const settings = patch.settings ? {
    ...currentSettings,
    ...patch.settings,
    providerWeights: { ...currentSettings.providerWeights, ...(patch.settings.providerWeights ?? {}) },
    djWeights: { ...currentSettings.djWeights, ...(patch.settings.djWeights ?? {}) },
  } : currentSettings;
  const now = new Date().toISOString();
  const type = patch.type ?? current.type;
  const name = patch.name ?? current.name;

  getDb().transaction(() => {
    getDb().query("UPDATE radio_stations SET name=?, type=?, default_length=?, settings_json=?, updated_at=? WHERE id=?")
      .run(name, type, settings.length, JSON.stringify(settings), now, id);
    if (patch.seeds) {
      getDb().query("DELETE FROM radio_station_seeds WHERE station_id=?").run(id);
      const stmt = getDb().query(`INSERT INTO radio_station_seeds (id,station_id,seed_type,entity_id,artist,title,label,weight,position,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      patch.seeds.forEach((seed, index) => stmt.run(
        `rseed_${ulid()}`, id, seed.type, seed.entityId ?? null, seed.artist ?? null, seed.title ?? null,
        seed.label, seed.weight ?? 1, seed.position ?? (type === "gradient" ? index : null), seed.metadata ? JSON.stringify(seed.metadata) : null, now,
      ));
    }
  })();

  return getStation(id);
}

export function deleteStation(id: string): boolean {
  return Number(getDb().query("DELETE FROM radio_stations WHERE id=?").run(id).changes ?? 0) > 0;
}

export function createGeneration(input: { stationId: string; requestedLength: number; generatorVersion: string; randomSeed: string; settingsSnapshot: RadioSettings }): RadioGenerationRow {
  const db = getDb();
  const id = `rgen_${ulid()}`;
  const now = new Date().toISOString();
  const revision = Number((db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(revision),0)+1 AS n FROM radio_generations WHERE station_id=?").get(input.stationId)?.n) ?? 1);
  db.query(`INSERT INTO radio_generations (id,station_id,revision,requested_length,generator_version,random_seed,status,settings_snapshot_json,created_at) VALUES (?,?,?,?,?,?, 'generating', ?,?)`)
    .run(id, input.stationId, revision, input.requestedLength, input.generatorVersion, input.randomSeed, JSON.stringify(input.settingsSnapshot), now);
  return getGeneration(id)!;
}

export function getGeneration(id: string): RadioGenerationRow | null {
  return getDb().query<RadioGenerationRow, [string]>("SELECT * FROM radio_generations WHERE id=?").get(id) ?? null;
}

export function listGenerations(stationId: string): RadioGenerationRow[] {
  return getDb().query<RadioGenerationRow, [string]>("SELECT * FROM radio_generations WHERE station_id=? ORDER BY created_at DESC").all(stationId);
}

export function finishGeneration(id: string, status: string, diagnostics: Record<string, unknown>): void {
  getDb().query("UPDATE radio_generations SET status=?, diagnostics_json=?, completed_at=? WHERE id=?")
    .run(status, JSON.stringify(diagnostics), new Date().toISOString(), id);
}

export function replaceGenerationTracks(generationId: string, tracks: Array<Omit<RadioTrackRow, "id" | "generation_id" | "created_at" | "position"> & { position?: number }>): RadioTrackRow[] {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.query("DELETE FROM radio_generation_tracks WHERE generation_id=?").run(generationId);
    const stmt = db.query(`INSERT INTO radio_generation_tracks (id,generation_id,position,canonical_key,artist,title,album,duration_ms,isrc,spotify_id,navidrome_id,musicbrainz_id,playback_source,availability_status,pinned,manual,selection_score,trajectory_position,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    tracks.forEach((track, index) => stmt.run(
      `rtrack_${ulid()}`, generationId, track.position ?? index, track.canonical_key, track.artist, track.title,
      track.album, track.duration_ms, track.isrc, track.spotify_id, track.navidrome_id, track.musicbrainz_id,
      track.playback_source, track.availability_status, track.pinned, track.manual, track.selection_score,
      track.trajectory_position, track.metadata_json, now,
    ));
  })();
  return getGenerationTracks(generationId);
}

export function getGenerationTracks(generationId: string): RadioTrackRow[] {
  return getDb().query<RadioTrackRow, [string]>("SELECT * FROM radio_generation_tracks WHERE generation_id=? ORDER BY position").all(generationId);
}

export function snapshotGeneration(generationId: string, reason: string): void {
  const tracks = getGenerationTracks(generationId);
  if (!tracks.length) return;
  const db = getDb();
  const revision = Number((db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(revision),0)+1 AS n FROM radio_generation_revisions WHERE generation_id=?").get(generationId)?.n) ?? 1);
  db.query("INSERT INTO radio_generation_revisions (id,generation_id,revision,tracks_json,reason,created_at) VALUES (?,?,?,?,?,?)")
    .run(`rrev_${ulid()}`, generationId, revision, JSON.stringify(tracks), reason, new Date().toISOString());
}

export function updateTrackPin(generationId: string, trackId: string, pinned: boolean): boolean {
  return Number(getDb().query("UPDATE radio_generation_tracks SET pinned=? WHERE generation_id=? AND id=?").run(pinned ? 1 : 0, generationId, trackId).changes ?? 0) > 0;
}

export function deleteGenerationTrack(generationId: string, trackId: string): boolean {
  const db = getDb();
  const row = db.query<{ position: number }, [string, string]>("SELECT position FROM radio_generation_tracks WHERE generation_id=? AND id=?").get(generationId, trackId);
  if (!row) return false;
  db.transaction(() => {
    db.query("DELETE FROM radio_generation_tracks WHERE generation_id=? AND id=?").run(generationId, trackId);
    db.query("UPDATE radio_generation_tracks SET position=position-1 WHERE generation_id=? AND position>?").run(generationId, row.position);
  })();
  return true;
}

export function addFeedback(input: { scope: "station" | "global"; stationId?: string | null; entityType: "track" | "artist"; entityKey: string; action: RadioFeedbackAction; strength?: number }): RadioFeedbackRow {
  const row: RadioFeedbackRow = {
    id: `rfb_${ulid()}`,
    scope: input.scope,
    station_id: input.stationId ?? null,
    entity_type: input.entityType,
    entity_key: input.entityKey,
    action: input.action,
    strength: input.strength ?? 1,
    created_at: new Date().toISOString(),
  };
  getDb().query("INSERT INTO radio_feedback (id,scope,station_id,entity_type,entity_key,action,strength,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(row.id, row.scope, row.station_id, row.entity_type, row.entity_key, row.action, row.strength, row.created_at);
  return row;
}

export function listFeedback(stationId?: string): RadioFeedbackRow[] {
  if (stationId) {
    return getDb().query<RadioFeedbackRow, [string]>("SELECT * FROM radio_feedback WHERE scope='global' OR station_id=? ORDER BY created_at").all(stationId);
  }
  return getDb().query<RadioFeedbackRow, []>("SELECT * FROM radio_feedback WHERE scope='global' ORDER BY created_at").all();
}