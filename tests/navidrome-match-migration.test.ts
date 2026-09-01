import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { getDb, initDatabase } from "../src/db/database";

const dbPath = `/tmp/music-api-navidrome-match-migration-${Date.now()}.sqlite`;

beforeAll(() => {
  const legacyDb = new Database(dbPath, { create: true });
  legacyDb.exec(`
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME NOT NULL
    );
    INSERT INTO _migrations(version, applied_at) VALUES
      (1, datetime('now')), (2, datetime('now')), (3, datetime('now')), (4, datetime('now')),
      (5, datetime('now')), (6, datetime('now')), (7, datetime('now')), (8, datetime('now')),
      (9, datetime('now')), (10, datetime('now')), (11, datetime('now')), (12, datetime('now')),
      (13, datetime('now'));

    CREATE TABLE recommendation_candidates (
      id TEXT PRIMARY KEY,
      navidrome_match_status TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE recommendations (
      id TEXT PRIMARY KEY,
      navidrome_match_status TEXT NOT NULL DEFAULT 'unknown'
    );
    INSERT INTO recommendation_candidates(id, navidrome_match_status) VALUES
      ('candidate-owned', 'owned'), ('candidate-unchecked', 'unchecked');
    INSERT INTO recommendations(id, navidrome_match_status) VALUES
      ('recommendation-missing', 'missing'), ('recommendation-possible', 'possible_match');

    CREATE TABLE radio_stations (
      id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL
    );
    CREATE TABLE radio_generations (
      id TEXT PRIMARY KEY,
      settings_snapshot_json TEXT NOT NULL
    );
    INSERT INTO radio_stations(id, settings_json)
      VALUES ('station-1', '{"ownedBias":0.6,"familiarity":0.4}');
    INSERT INTO radio_generations(id, settings_snapshot_json)
      VALUES ('generation-1', '{"ownedBias":-0.25,"navidromeBias":0.2}');
  `);
  legacyDb.close();

  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = "test-test-test-test-test-test-test-test";
  process.env.NAVIDROME_USERNAME = "test";
  process.env.NAVIDROME_PASSWORD = "test";
  process.env.LASTFM_API_KEY = "test";
  process.env.LASTFM_USERNAME = "test";
  resetConfigForTests();
  initDatabase();
});

afterAll(() => {
  try { unlinkSync(dbPath); } catch {}
});

describe("Navidrome match status migration", () => {
  test("uses unchecked as the durable database default", () => {
    const candidateColumn = getDb()
      .query<{ dflt_value: string | null }, []>(
        `SELECT dflt_value FROM pragma_table_info('recommendation_candidates') WHERE name = 'navidrome_match_status'`
      )
      .get();
    const recommendationColumn = getDb()
      .query<{ dflt_value: string | null }, []>(
        `SELECT dflt_value FROM pragma_table_info('recommendations') WHERE name = 'navidrome_match_status'`
      )
      .get();

    expect(candidateColumn?.dflt_value).toBe("'unchecked'");
    expect(recommendationColumn?.dflt_value).toBe("'unchecked'");
  });

  test("maps residual legacy status values while rebuilding the columns", () => {
    const candidate = getDb()
      .query<{ navidrome_match_status: string }, [string]>(
        "SELECT navidrome_match_status FROM recommendation_candidates WHERE id = ?"
      )
      .get("candidate-owned");
    const recommendation = getDb()
      .query<{ navidrome_match_status: string }, [string]>(
        "SELECT navidrome_match_status FROM recommendations WHERE id = ?"
      )
      .get("recommendation-missing");

    expect(candidate?.navidrome_match_status).toBe("matched");
    expect(recommendation?.navidrome_match_status).toBe("not_found");
  });

  test("normalizes persisted legacy radio bias without overriding the new key", () => {
    const station = getDb()
      .query<{ settings_json: string }, [string]>("SELECT settings_json FROM radio_stations WHERE id = ?")
      .get("station-1");
    const generation = getDb()
      .query<{ settings_snapshot_json: string }, [string]>(
        "SELECT settings_snapshot_json FROM radio_generations WHERE id = ?"
      )
      .get("generation-1");

    expect(JSON.parse(station!.settings_json)).toEqual({ familiarity: 0.4, navidromeBias: 0.6 });
    expect(JSON.parse(generation!.settings_snapshot_json)).toEqual({ navidromeBias: 0.2 });
  });

  test("records the default-repair migration", () => {
    const row = getDb()
      .query<{ version: number }, [number]>("SELECT version FROM _migrations WHERE version = ?")
      .get(14);
    expect(row?.version).toBe(14);
  });
});
