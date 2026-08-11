import { getDb } from "../database";

export interface AliasRecord {
  canonical_artist: string;
  alias: string;
  source: string | null;
  confidence: number | null;
}

export function addAlias(params: {
  canonicalArtist: string;
  alias: string;
  source?: string;
  confidence?: number;
}): void {
  const db = getDb();
  db.query(`
    INSERT INTO artist_aliases (canonical_artist, alias, source, confidence)
    VALUES (?, ?, ?, ?)
  `).run(
    params.canonicalArtist,
    params.alias,
    params.source ?? null,
    params.confidence ?? null
  );
}

export function addAliases(
  canonicalArtist: string,
  aliases: { name: string; source?: string; confidence?: number }[]
): void {
  for (const a of aliases) {
    addAlias({
      canonicalArtist,
      alias: a.name,
      source: a.source,
      confidence: a.confidence,
    });
  }
}

export function getAliasesForArtist(canonicalArtist: string): AliasRecord[] {
  const db = getDb();
  return db
    .query<AliasRecord, [string]>(
      "SELECT * FROM artist_aliases WHERE canonical_artist = ?"
    )
    .all(canonicalArtist);
}

export function findCanonicalByAlias(alias: string): AliasRecord[] {
  const db = getDb();
  return db
    .query<AliasRecord, [string]>(
      "SELECT * FROM artist_aliases WHERE LOWER(alias) = LOWER(?)"
    )
    .all(alias);
}

export function clearAliasesForArtist(canonicalArtist: string): void {
  const db = getDb();
  db.query("DELETE FROM artist_aliases WHERE canonical_artist = ?").run(
    canonicalArtist
  );
}
