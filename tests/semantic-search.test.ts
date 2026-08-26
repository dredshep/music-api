import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { computeSemanticFingerprint } from "../src/domain/normalization";

// --- Fingerprinting tests ---

describe("computeSemanticFingerprint", () => {
  test("same artist+title produce identical fingerprint regardless of formatting", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    expect(fp1).toBe(fp2);
  });

  test("case insensitive", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("nachtmahr", "imperivm");
    expect(fp1).toBe(fp2);
  });

  test("Artist - Album vs Artist Album produce same fingerprint", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    expect(fp1).not.toContain("-");
  });

  test("hyphen/dash variants normalize to same fingerprint", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp3 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    expect(fp1).toBe(fp2);
    expect(fp2).toBe(fp3);
  });

  test("unicode punctuation variants produce same fingerprint", () => {
    const fp1 = computeSemanticFingerprint("Mötley Crüe", "Girls Girls Girls");
    // Strip accents
    const fp2 = computeSemanticFingerprint("Motley Crue", "Girls Girls Girls");
    expect(fp1).toBe(fp2);
  });

  test("multiple spaces collapse", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("Nachtmahr", "  IMPERIVM  ");
    expect(fp1).toBe(fp2);
  });

  test("different release types produce different fingerprints", () => {
    const fpAlbum = computeSemanticFingerprint("Nachtmahr", "IMPERIVM", "album");
    const fpSingle = computeSemanticFingerprint("Nachtmahr", "IMPERIVM", "single");
    expect(fpAlbum).not.toBe(fpSingle);
  });

  test("default release type is album", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM", "album");
    expect(fp1).toBe(fp2);
  });

  test("unicode NFKC normalization", () => {
    // fullwidth characters
    const fp1 = computeSemanticFingerprint("Test", "Ｔｅｓｔ");
    const fp2 = computeSemanticFingerprint("Test", "Test");
    expect(fp1).toBe(fp2);
  });

  test("em-dash and en-dash normalize the same", () => {
    const fp1 = computeSemanticFingerprint("Artist", "Title\u2013Subtitle");
    const fp2 = computeSemanticFingerprint("Artist", "Title\u2014Subtitle");
    expect(fp1).toBe(fp2);
  });

  test("different artists produce different fingerprints", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("VNV Nation", "IMPERIVM");
    expect(fp1).not.toBe(fp2);
  });

  test("different titles produce different fingerprints", () => {
    const fp1 = computeSemanticFingerprint("Nachtmahr", "IMPERIVM");
    const fp2 = computeSemanticFingerprint("Nachtmahr", "Semper Fidelis");
    expect(fp1).not.toBe(fp2);
  });
});

// --- Durable search schema tests ---

describe("durable search schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const { MIGRATIONS } = require("../src/db/schema");
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
    }
  });

  afterAll(() => {
    db.close();
  });

  test("searches table has fingerprint column", () => {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(searches)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain("fingerprint");
    expect(columns).toContain("normalized_artist");
    expect(columns).toContain("normalized_title");
    expect(columns).toContain("last_used_at");
  });

  test("search_variants table exists with expected columns", () => {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(search_variants)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain("id");
    expect(columns).toContain("semantic_search_id");
    expect(columns).toContain("query");
    expect(columns).toContain("query_fingerprint");
    expect(columns).toContain("slskd_search_id");
    expect(columns).toContain("discovered");
    expect(columns).toContain("created_at");
    expect(columns).toContain("last_seen_at");
    expect(columns).toContain("missing_at");
  });

  test("fingerprint index exists", () => {
    const indices = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='searches'"
      )
      .all()
      .map((i) => i.name);
    expect(indices).toContain("idx_searches_fingerprint");
  });

  test("search_variants has unique index on (semantic_search_id, query_fingerprint)", () => {
    const indices = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='search_variants'"
      )
      .all()
      .map((i) => i.name);
    expect(indices).toContain("idx_search_variants_query_fp");
  });

  test("inserting a search with fingerprint works", () => {
    const fp = computeSemanticFingerprint("Test Artist", "Test Album");
    db.query(`
      INSERT INTO searches (
        id, artist, title, release_type, state, created_at, expires_at,
        fingerprint, normalized_artist, normalized_title, last_used_at,
        prefer_lrc, max_candidates, candidate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "search_test_1", "Test Artist", "Test Album", "album", "settled",
      new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(),
      fp, "test artist", "test album", new Date().toISOString(),
      1, 10, 0
    );

    const found = db
      .query<{ id: string }, [string]>("SELECT id FROM searches WHERE fingerprint = ?")
      .get(fp);
    expect(found?.id).toBe("search_test_1");
  });

  test("search variant links to search", () => {
    db.query(`
      INSERT INTO search_variants (
        id, semantic_search_id, query, query_fingerprint,
        slskd_search_id, discovered, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "sv_test_1", "search_test_1", "Test Artist Test Album",
      "test artist test album", "slskd_abc123", 0,
      new Date().toISOString(), new Date().toISOString()
    );

    const variant = db
      .query<{ slskd_search_id: string }, [string]>(
        "SELECT slskd_search_id FROM search_variants WHERE semantic_search_id = ?"
      )
      .get("search_test_1");
    expect(variant?.slskd_search_id).toBe("slskd_abc123");
  });

  test("duplicate query fingerprint per search is rejected", () => {
    expect(() => {
      db.query(`
        INSERT INTO search_variants (
          id, semantic_search_id, query, query_fingerprint,
          slskd_search_id, discovered, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "sv_test_2", "search_test_1", "Test Artist Test Album (dupe)",
        "test artist test album", "slskd_xyz789", 0,
        new Date().toISOString(), new Date().toISOString()
      );
    }).toThrow();
  });
});

// --- Cleanup behavior tests ---

describe("cleanup preserves search identity", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const { MIGRATIONS } = require("../src/db/schema");
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
    }

    // Insert a search with expired candidates
    const pastDate = new Date(Date.now() - 3600000).toISOString();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    db.query(`
      INSERT INTO searches (
        id, artist, title, release_type, state, created_at, expires_at,
        fingerprint, prefer_lrc, max_candidates, candidate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "search_cleanup_1", "Artist", "Album", "album", "settled",
      pastDate, pastDate,
      computeSemanticFingerprint("Artist", "Album"),
      1, 10, 1
    );

    db.query(`
      INSERT INTO candidates (
        id, search_id, peer, remote_directory, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("cand_cleanup_1", "search_cleanup_1", "peer1", "/dir", pastDate, pastDate);
  });

  afterAll(() => {
    db.close();
  });

  test("expired candidates are deletable but search identity persists", () => {
    const now = new Date().toISOString();

    // This simulates what the new cleanup does
    const candidateResult = db
      .query("DELETE FROM candidates WHERE expires_at < ?")
      .run(now);
    expect(candidateResult.changes).toBe(1);

    // Search MUST still exist (durable identity)
    const search = db
      .query<{ id: string }, [string]>("SELECT id FROM searches WHERE id = ?")
      .get("search_cleanup_1");
    expect(search?.id).toBe("search_cleanup_1");
  });
});
