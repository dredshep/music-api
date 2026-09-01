import { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { MIGRATIONS } from "./schema";
import { ACQUISITION_MIGRATIONS } from "./acquisition-migrations";
import { RADIO_MIGRATIONS } from "./radio-migrations";
import { log } from "../middleware/logging";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .query<{ name: string }, [string]>(
      `SELECT name FROM pragma_table_info(?) WHERE name = ?`
    )
    .all(table, column);
  return rows.length > 0;
}

function applyNavidromeMatchStatusMigration(db: Database): void {
  if (tableHasColumn(db, "recommendation_candidates", "ownership_state")) {
    db.exec("ALTER TABLE recommendation_candidates RENAME COLUMN ownership_state TO navidrome_match_status");
  }
  if (tableHasColumn(db, "recommendation_candidates", "ownership_confidence")) {
    db.exec("ALTER TABLE recommendation_candidates RENAME COLUMN ownership_confidence TO navidrome_match_confidence");
  }
  if (tableHasColumn(db, "recommendations", "ownership_state")) {
    db.exec("ALTER TABLE recommendations RENAME COLUMN ownership_state TO navidrome_match_status");
  }

  db.exec(`
    UPDATE recommendation_candidates SET navidrome_match_status = CASE
      WHEN navidrome_match_status = 'owned' THEN 'matched'
      WHEN navidrome_match_status = 'uncertain' THEN 'possible_match'
      WHEN navidrome_match_status = 'missing' THEN 'not_found'
      WHEN navidrome_match_status = 'unknown' THEN 'unchecked'
      ELSE navidrome_match_status
    END;

    UPDATE recommendations SET navidrome_match_status = CASE
      WHEN navidrome_match_status = 'owned' THEN 'matched'
      WHEN navidrome_match_status = 'uncertain' THEN 'possible_match'
      WHEN navidrome_match_status = 'missing' THEN 'not_found'
      WHEN navidrome_match_status = 'unknown' THEN 'unchecked'
      ELSE navidrome_match_status
    END;
  `);
}

export function initDatabase(): void {
  const config = getConfig();
  const dbPath = config.DATABASE_PATH;

  log("info", "database_init", { path: dbPath });

  _db = new Database(dbPath, { create: true });

  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(_db);
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL
    )
  `);

  const applied = db
    .query<{ version: number }, []>("SELECT version FROM _migrations")
    .all()
    .map((r) => r.version);

  for (const migration of [...MIGRATIONS, ...ACQUISITION_MIGRATIONS, ...RADIO_MIGRATIONS]) {
    if (!applied.includes(migration.version)) {
      log("info", "migration_apply", { version: migration.version });
      if (migration.version === 13) {
        applyNavidromeMatchStatusMigration(db);
      } else {
        db.exec(migration.sql);
      }
      db.query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
  }
}
