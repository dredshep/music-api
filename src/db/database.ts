import { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { MIGRATIONS } from "./schema";
import { log } from "../middleware/logging";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
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

  for (const migration of MIGRATIONS) {
    if (!applied.includes(migration.version)) {
      log("info", "migration_apply", { version: migration.version });
      db.exec(migration.sql);
      db.query("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
  }
}
