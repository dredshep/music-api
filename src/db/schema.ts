export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS searches (
        id TEXT PRIMARY KEY,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        release_type TEXT,
        raw_query TEXT,
        slskd_search_ids_json TEXT,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        search_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        remote_directory TEXT NOT NULL,
        display_release TEXT,
        format TEXT,
        track_count INTEGER,
        audio_file_count INTEGER,
        lrc_count INTEGER,
        image_count INTEGER,
        sidecar_count INTEGER,
        lrc_coverage REAL,
        total_bytes INTEGER,
        upload_speed INTEGER,
        free_upload_slots BOOLEAN,
        queue_length INTEGER,
        score REAL,
        reason TEXT,
        flags_json TEXT,
        files_json TEXT,
        raw_json TEXT,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (search_id) REFERENCES searches(id)
      );

      CREATE TABLE IF NOT EXISTS download_jobs (
        id TEXT PRIMARY KEY,
        candidate_id TEXT,
        artist TEXT,
        release_title TEXT,
        release_type TEXT,
        musicbrainz_release_group_id TEXT,
        selected_format TEXT,
        original_query_json TEXT,
        edition_hints_json TEXT,
        peer TEXT,
        remote_directory TEXT,
        status TEXT NOT NULL,
        attempt INTEGER DEFAULT 1,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS download_job_files (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        logical_filename TEXT NOT NULL,
        remote_filename TEXT NOT NULL,
        size INTEGER,
        kind TEXT NOT NULL,
        original_peer TEXT,
        current_peer TEXT,
        slskd_transfer_id TEXT,
        status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        FOREIGN KEY (job_id) REFERENCES download_jobs(id)
      );

      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artist_aliases (
        canonical_artist TEXT NOT NULL,
        alias TEXT NOT NULL,
        source TEXT,
        confidence REAL
      );

      CREATE INDEX IF NOT EXISTS idx_candidates_search_id ON candidates(search_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_expires_at ON candidates(expires_at);
      CREATE INDEX IF NOT EXISTS idx_searches_expires_at ON searches(expires_at);
      CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_download_jobs_candidate_id ON download_jobs(candidate_id);
      CREATE INDEX IF NOT EXISTS idx_download_job_files_job_id ON download_job_files(job_id);
      CREATE INDEX IF NOT EXISTS idx_download_job_files_status ON download_job_files(status);
      CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_artist_aliases_alias ON artist_aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_artist_aliases_canonical ON artist_aliases(canonical_artist);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_artists (
        mbid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        disambiguation TEXT,
        catalog_checked_at DATETIME,
        created_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_release_groups (
        mbid TEXT PRIMARY KEY,
        artist_mbid TEXT NOT NULL,
        title TEXT NOT NULL,
        primary_type TEXT,
        secondary_types_json TEXT,
        first_release_date TEXT,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (artist_mbid) REFERENCES catalog_artists(mbid)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_rg_artist ON catalog_release_groups(artist_mbid);
      CREATE INDEX IF NOT EXISTS idx_catalog_rg_type ON catalog_release_groups(primary_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_artists_name ON catalog_artists(name COLLATE NOCASE);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE download_jobs ADD COLUMN last_error TEXT;

      -- Repair jobs that failed before enqueue succeeded but left files as queued
      UPDATE download_job_files
      SET status = 'failed',
          last_error = COALESCE(last_error, 'enqueue never reached slskd'),
          updated_at = datetime('now')
      WHERE status = 'queued'
        AND job_id IN (SELECT id FROM download_jobs WHERE status = 'failed');

      UPDATE download_jobs
      SET last_error = COALESCE(last_error, 'enqueue rejected by slskd (pre-dedupe duplicate files)')
      WHERE status = 'failed' AND last_error IS NULL;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS api_suggestions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        severity TEXT NOT NULL DEFAULT 'medium',
        component TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        observed_behavior_json TEXT,
        expected_behavior TEXT,
        suggested_fix TEXT,
        context_json TEXT,
        dedupe_key TEXT,
        request_id TEXT,
        occurrences INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_suggestions_status ON api_suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_api_suggestions_type ON api_suggestions(type);
      CREATE INDEX IF NOT EXISTS idx_api_suggestions_component ON api_suggestions(component);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_suggestions_dedupe_open
        ON api_suggestions(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open';
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS recommendation_generations (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        started_at DATETIME NOT NULL,
        completed_at DATETIME,
        seed_count INTEGER DEFAULT 0,
        observation_count INTEGER DEFAULT 0,
        canonical_candidate_count INTEGER DEFAULT 0,
        eligible_candidate_count INTEGER DEFAULT 0,
        selected_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        config_json TEXT,
        stats_json TEXT,
        error_json TEXT
      );

      CREATE TABLE IF NOT EXISTS recommendation_candidates (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        artist_mbid TEXT,
        release_group_mbid TEXT,
        artist_name TEXT NOT NULL,
        release_title TEXT,
        first_release_date TEXT,
        ownership_state TEXT NOT NULL DEFAULT 'unknown',
        ownership_confidence REAL DEFAULT 0,
        score REAL DEFAULT 0,
        score_breakdown_json TEXT,
        primary_reason TEXT,
        selected INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES recommendation_generations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_rec_cand_gen ON recommendation_candidates(generation_id);
      CREATE INDEX IF NOT EXISTS idx_rec_cand_artist ON recommendation_candidates(artist_mbid);
      CREATE INDEX IF NOT EXISTS idx_rec_cand_rg ON recommendation_candidates(release_group_mbid);

      CREATE TABLE IF NOT EXISTS recommendation_evidence (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_score REAL,
        seed_artist_mbid TEXT,
        seed_artist_name TEXT,
        seed_affinity REAL,
        recording_mbid TEXT,
        metadata_json TEXT,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES recommendation_candidates(id)
      );

      CREATE INDEX IF NOT EXISTS idx_rec_evidence_cand ON recommendation_evidence(candidate_id);

      CREATE TABLE IF NOT EXISTS recommendations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        artist_mbid TEXT,
        release_group_mbid TEXT,
        artist_name TEXT NOT NULL,
        release_title TEXT,
        first_release_date TEXT,
        score REAL DEFAULT 0,
        score_breakdown_json TEXT,
        primary_reason TEXT,
        ownership_state TEXT NOT NULL DEFAULT 'unknown',
        first_seen_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL,
        last_recommended_at DATETIME,
        times_seen INTEGER NOT NULL DEFAULT 1,
        times_recommended INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        feedback TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_artist_mbid
        ON recommendations(artist_mbid) WHERE type = 'artist' AND artist_mbid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_rg_mbid
        ON recommendations(release_group_mbid) WHERE type = 'release_group' AND release_group_mbid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_rec_status ON recommendations(status);
      CREATE INDEX IF NOT EXISTS idx_rec_score ON recommendations(score DESC);
      CREATE INDEX IF NOT EXISTS idx_rec_reason ON recommendations(primary_reason);

      CREATE TABLE IF NOT EXISTS recommendation_feedback (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL,
        feedback TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        FOREIGN KEY (recommendation_id) REFERENCES recommendations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_rec_fb_rec ON recommendation_feedback(recommendation_id);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE searches ADD COLUMN state TEXT NOT NULL DEFAULT 'collecting';
      ALTER TABLE searches ADD COLUMN search_options_json TEXT;
      ALTER TABLE searches ADD COLUMN preferred_formats_json TEXT;
      ALTER TABLE searches ADD COLUMN prefer_lrc INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE searches ADD COLUMN max_candidates INTEGER NOT NULL DEFAULT 10;
      ALTER TABLE searches ADD COLUMN lifecycle_json TEXT;
      ALTER TABLE searches ADD COLUMN diagnostics_json TEXT;
      ALTER TABLE searches ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE searches ADD COLUMN last_refreshed_at DATETIME;
      ALTER TABLE searches ADD COLUMN settled_at DATETIME;

      -- Deduplicate legacy candidates before adding uniqueness constraint
      DELETE FROM candidates
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM candidates
          GROUP BY search_id, peer, remote_directory
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_search_peer_dir
        ON candidates(search_id, peer, remote_directory);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS lyric_acquisitions (
        id TEXT PRIMARY KEY,
        navidrome_song_id TEXT,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT,
        lrclib_id INTEGER,
        match_type TEXT NOT NULL,
        match_confidence REAL NOT NULL DEFAULT 0,
        duration_delta_s REAL,
        has_synced INTEGER NOT NULL DEFAULT 0,
        has_plain INTEGER NOT NULL DEFAULT 0,
        synced_lyrics TEXT,
        plain_lyrics TEXT,
        status TEXT NOT NULL DEFAULT 'staged',
        target_path TEXT,
        staged_path TEXT,
        deployed_at DATETIME,
        created_at DATETIME NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lyric_acq_song ON lyric_acquisitions(navidrome_song_id);
      CREATE INDEX IF NOT EXISTS idx_lyric_acq_status ON lyric_acquisitions(status);
      CREATE INDEX IF NOT EXISTS idx_lyric_acq_lrclib ON lyric_acquisitions(lrclib_id);
    `,
  },
  {
    version: 8,
    sql: `
      -- Make searches durable: add fingerprint for identity dedup,
      -- normalized fields, and last_used_at for access tracking.
      ALTER TABLE searches ADD COLUMN fingerprint TEXT;
      ALTER TABLE searches ADD COLUMN normalized_artist TEXT;
      ALTER TABLE searches ADD COLUMN normalized_title TEXT;
      ALTER TABLE searches ADD COLUMN last_used_at DATETIME;

      CREATE INDEX IF NOT EXISTS idx_searches_fingerprint ON searches(fingerprint);

      -- Search variants: map semantic searches to individual slskd search IDs.
      -- Each variant is one query string sent to slskd.
      CREATE TABLE IF NOT EXISTS search_variants (
        id TEXT PRIMARY KEY,
        semantic_search_id TEXT NOT NULL,
        query TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        slskd_search_id TEXT NOT NULL,
        discovered INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL,
        missing_at DATETIME,
        FOREIGN KEY (semantic_search_id) REFERENCES searches(id)
      );

      CREATE INDEX IF NOT EXISTS idx_search_variants_semantic
        ON search_variants(semantic_search_id);
      CREATE INDEX IF NOT EXISTS idx_search_variants_slskd
        ON search_variants(slskd_search_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_search_variants_query_fp
        ON search_variants(semantic_search_id, query_fingerprint);
    `,
  },
  {
    version: 12,
    sql: `
      -- Durable whole-library ownership source. Expiration marks a snapshot
      -- stale for background scheduling but never makes it unservable.
      CREATE TABLE IF NOT EXISTS library_snapshots (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version TEXT NOT NULL,
        songs_json TEXT NOT NULL,
        song_count INTEGER NOT NULL DEFAULT 0,
        built_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        last_error TEXT
      );
    `,
  },
];
