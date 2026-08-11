import { getDb } from "../database";

export function getCache<T>(key: string): T | null {
  const db = getDb();
  const row = db
    .query<{ value_json: string; expires_at: string }, [string]>(
      "SELECT value_json, expires_at FROM cache WHERE key = ?"
    )
    .get(key);

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.query("DELETE FROM cache WHERE key = ?").run(key);
    return null;
  }

  return JSON.parse(row.value_json) as T;
}

export function setCache<T>(key: string, value: T, ttlMs: number): void {
  const db = getDb();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const valueJson = JSON.stringify(value);

  db.query(
    "INSERT OR REPLACE INTO cache (key, value_json, expires_at) VALUES (?, ?, ?)"
  ).run(key, valueJson, expiresAt);
}

export function deleteCache(key: string): void {
  const db = getDb();
  db.query("DELETE FROM cache WHERE key = ?").run(key);
}

export function deleteCacheByPrefix(prefix: string): void {
  const db = getDb();
  db.query("DELETE FROM cache WHERE key LIKE ?").run(`${prefix}%`);
}
