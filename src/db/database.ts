import { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { MIGRATIONS } from "./schema";
import { ACQUISITION_MIGRATIONS } from "./acquisition-migrations";
import { RADIO_MIGRATIONS } from "./radio-migrations";
import { log } from "../middleware/logging";

let _db: Database | null = null;

const NAVIDROME_MATCH_DEFAULT_MIGRATION_VERSION = 14;

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

function getColumnDefault(db: Database, table: string, column: string): string | null {
  const row = db
    .query<{ dflt_value: string | null }, [string, string]>(
      `SELECT dflt_value FROM pragma_table_info(?) WHERE name = ?`
    )
    .get(table, column);
  return row?.dflt_value ?? null;
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

function rebuildNavidromeMatchStatusColumn(db: Database, table: "recommendation_candidates" | "recommendations"): void {
  if (!tableHasColumn(db, table, "navidrome_match_status")) return;
  const currentDefault = getColumnDefault(db, table, "navidrome_match_status");
  if (currentDefault?.includes("unchecked")) return;

  const replacement = "__navidrome_match_status_v14";
  db.exec(`
    ALTER TABLE ${table}
      ADD COLUMN ${replacement} TEXT NOT NULL DEFAULT 'unchecked'
      CHECK (${replacement} IN ('matched', 'possible_match', 'not_found', 'unchecked'));

    UPDATE ${table} SET ${replacement} = CASE
      WHEN navidrome_match_status = 'matched' THEN 'matched'
      WHEN navidrome_match_status = 'possible_match' THEN 'possible_match'
      WHEN navidrome_match_status = 'not_found' THEN 'not_found'
      WHEN navidrome_match_status = 'unchecked' THEN 'unchecked'
      WHEN navidrome_match_status = 'owned' THEN 'matched'
      WHEN navidrome_match_status = 'uncertain' THEN 'possible_match'
      WHEN navidrome_match_status = 'missing' THEN 'not_found'
      ELSE 'unchecked'
    END;

    ALTER TABLE ${table} DROP COLUMN navidrome_match_status;
    ALTER TABLE ${table} RENAME COLUMN ${replacement} TO navidrome_match_status;
  `);
}

function normalizeLegacyRadioSettings(db: Database): void {
  const targets = [
    { table: "radio_stations", id: "id", column: "settings_json" },
    { table: "radio_generations", id: "id", column: "settings_snapshot_json" },
  ] as const;

  for (const target of targets) {
    const rows = db
      .query<{ id: string; value: string }, []>(
        `SELECT ${target.id} AS id, ${target.column} AS value FROM ${target.table}`
      )
      .all();
    const update = db.query(
      `UPDATE ${target.table} SET ${target.column} = ? WHERE ${target.id} = ?`
    );

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        if (!("ownedBias" in parsed)) continue;
        if (parsed.navidromeBias == null && typeof parsed.ownedBias === "number") {
          parsed.navidromeBias = parsed.ownedBias;
        }
        delete parsed.ownedBias;
        update.run(JSON.stringify(parsed), row.id);
      } catch {
        // Preserve malformed legacy settings; parseRadioSettings still falls back safely.
      }
    }
  }
}

function applyNavidromeMatchDefaultMigration(db: Database): void {
  db.exec("BEGIN");
  try {
    rebuildNavidromeMatchStatusColumn(db, "recommendation_candidates");
    rebuildNavidromeMatchStatusColumn(db, "recommendations");
    normalizeLegacyRadioSettings(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

  if (!applied.includes(NAVIDROME_MATCH_DEFAULT_MIGRATION_VERSION)) {
    log("info", "migration_apply", { version: NAVIDROME_MATCH_DEFAULT_MIGRATION_VERSION });
    applyNavidromeMatchDefaultMigration(db);
    db.query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
      .run(NAVIDROME_MATCH_DEFAULT_MIGRATION_VERSION, new Date().toISOString());
  }
}
