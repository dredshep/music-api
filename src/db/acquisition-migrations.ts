export const ACQUISITION_MIGRATIONS = [
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS acquisitions (
        id TEXT PRIMARY KEY,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        release_type TEXT NOT NULL,
        search_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'acquiring',
        current_job_id TEXT,
        attempted_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
        blocked_peers_json TEXT NOT NULL DEFAULT '[]',
        source_attempts INTEGER NOT NULL DEFAULT 0,
        max_source_attempts INTEGER NOT NULL DEFAULT 5,
        verification_started_at DATETIME,
        last_error TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME,
        FOREIGN KEY (search_id) REFERENCES searches(id),
        FOREIGN KEY (current_job_id) REFERENCES download_jobs(id)
      );

      CREATE TABLE IF NOT EXISTS acquisition_attempts (
        id TEXT PRIMARY KEY,
        acquisition_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at DATETIME NOT NULL,
        completed_at DATETIME,
        FOREIGN KEY (acquisition_id) REFERENCES acquisitions(id),
        FOREIGN KEY (job_id) REFERENCES download_jobs(id)
      );

      -- candidate_id is intentionally historical text rather than an FK:
      -- candidate snapshots are TTL-pruned while acquisition history persists.
      CREATE INDEX IF NOT EXISTS idx_acquisitions_status
        ON acquisitions(status);
      CREATE INDEX IF NOT EXISTS idx_acquisitions_current_job
        ON acquisitions(current_job_id);
      CREATE INDEX IF NOT EXISTS idx_acquisition_attempts_acquisition
        ON acquisition_attempts(acquisition_id);
      CREATE INDEX IF NOT EXISTS idx_acquisition_attempts_job
        ON acquisition_attempts(job_id);
    `,
  },
];
