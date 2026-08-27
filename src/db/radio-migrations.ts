export const RADIO_MIGRATIONS = [
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS radio_stations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'standard',
        default_length INTEGER NOT NULL DEFAULT 30,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS radio_station_seeds (
        id TEXT PRIMARY KEY,
        station_id TEXT NOT NULL,
        seed_type TEXT NOT NULL,
        entity_id TEXT,
        artist TEXT,
        title TEXT,
        label TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        position REAL,
        metadata_json TEXT,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (station_id) REFERENCES radio_stations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_radio_seeds_station
        ON radio_station_seeds(station_id, position, created_at);

      CREATE TABLE IF NOT EXISTS radio_generations (
        id TEXT PRIMARY KEY,
        station_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        requested_length INTEGER NOT NULL,
        generator_version TEXT NOT NULL,
        random_seed TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'generating',
        settings_snapshot_json TEXT NOT NULL,
        diagnostics_json TEXT,
        created_at DATETIME NOT NULL,
        completed_at DATETIME,
        FOREIGN KEY (station_id) REFERENCES radio_stations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_radio_generations_station
        ON radio_generations(station_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS radio_generation_tracks (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        canonical_key TEXT NOT NULL,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT,
        duration_ms INTEGER,
        isrc TEXT,
        spotify_id TEXT,
        navidrome_id TEXT,
        musicbrainz_id TEXT,
        playback_source TEXT,
        availability_status TEXT NOT NULL DEFAULT 'unknown',
        pinned INTEGER NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0,
        selection_score REAL NOT NULL DEFAULT 0,
        trajectory_position REAL,
        metadata_json TEXT,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES radio_generations(id) ON DELETE CASCADE,
        UNIQUE(generation_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_radio_tracks_generation
        ON radio_generation_tracks(generation_id, position);
      CREATE INDEX IF NOT EXISTS idx_radio_tracks_canonical
        ON radio_generation_tracks(canonical_key);

      CREATE TABLE IF NOT EXISTS radio_feedback (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        station_id TEXT,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        action TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (station_id) REFERENCES radio_stations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_radio_feedback_scope
        ON radio_feedback(scope, station_id, entity_type, entity_key);

      CREATE TABLE IF NOT EXISTS radio_generation_revisions (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        tracks_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES radio_generations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_radio_revisions_generation
        ON radio_generation_revisions(generation_id, revision DESC);

      CREATE TABLE IF NOT EXISTS track_audio_analysis (
        canonical_key TEXT NOT NULL,
        analysis_version INTEGER NOT NULL,
        bpm REAL,
        musical_key TEXT,
        mode TEXT,
        loudness REAL,
        energy REAL,
        timbre_json TEXT,
        rhythm_json TEXT,
        intro_json TEXT,
        outro_json TEXT,
        source_fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (canonical_key, analysis_version)
      );
    `,
  },
];
