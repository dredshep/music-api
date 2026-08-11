import { getDb } from "../database";

export interface CatalogArtistRecord {
  mbid: string;
  name: string;
  disambiguation: string | null;
  catalog_checked_at: string | null;
  created_at: string;
}

export interface CatalogReleaseGroupRecord {
  mbid: string;
  artist_mbid: string;
  title: string;
  primary_type: string | null;
  secondary_types_json: string | null;
  first_release_date: string | null;
  created_at: string;
}

export function getCatalogArtist(mbid: string): CatalogArtistRecord | null {
  const db = getDb();
  return (
    db
      .query<CatalogArtistRecord, [string]>(
        "SELECT * FROM catalog_artists WHERE mbid = ?"
      )
      .get(mbid) ?? null
  );
}

export function listCatalogArtists(options?: {
  onlyChecked?: boolean;
}): CatalogArtistRecord[] {
  const db = getDb();
  if (options?.onlyChecked) {
    return db
      .query<CatalogArtistRecord, []>(
        "SELECT * FROM catalog_artists WHERE catalog_checked_at IS NOT NULL ORDER BY name COLLATE NOCASE"
      )
      .all();
  }
  return db
    .query<CatalogArtistRecord, []>(
      "SELECT * FROM catalog_artists ORDER BY name COLLATE NOCASE"
    )
    .all();
}

export function upsertCatalogArtist(params: {
  mbid: string;
  name: string;
  disambiguation?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO catalog_artists (mbid, name, disambiguation, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(mbid) DO UPDATE SET name = excluded.name, disambiguation = excluded.disambiguation
  `).run(params.mbid, params.name, params.disambiguation ?? null, now);
}

export function markCatalogChecked(mbid: string): void {
  const db = getDb();
  db.query(
    "UPDATE catalog_artists SET catalog_checked_at = ? WHERE mbid = ?"
  ).run(new Date().toISOString(), mbid);
}

export function isCatalogStale(
  artist: CatalogArtistRecord,
  maxAgeDays: number
): boolean {
  if (!artist.catalog_checked_at) return true;
  const checkedAt = new Date(artist.catalog_checked_at).getTime();
  const age = Date.now() - checkedAt;
  return age > maxAgeDays * 24 * 60 * 60 * 1000;
}

export function getReleaseGroupsForArtist(
  artistMbid: string
): CatalogReleaseGroupRecord[] {
  const db = getDb();
  return db
    .query<CatalogReleaseGroupRecord, [string]>(
      "SELECT * FROM catalog_release_groups WHERE artist_mbid = ? ORDER BY first_release_date DESC"
    )
    .all(artistMbid);
}

export function upsertReleaseGroups(
  artistMbid: string,
  groups: {
    mbid: string;
    title: string;
    primaryType?: string;
    secondaryTypes?: string[];
    firstReleaseDate?: string;
  }[]
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.query(`
    INSERT INTO catalog_release_groups (mbid, artist_mbid, title, primary_type, secondary_types_json, first_release_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mbid) DO UPDATE SET
      title = excluded.title,
      primary_type = excluded.primary_type,
      secondary_types_json = excluded.secondary_types_json,
      first_release_date = excluded.first_release_date
  `);

  for (const rg of groups) {
    stmt.run(
      rg.mbid,
      artistMbid,
      rg.title,
      rg.primaryType ?? null,
      rg.secondaryTypes?.length ? JSON.stringify(rg.secondaryTypes) : null,
      rg.firstReleaseDate ?? null,
      now
    );
  }
}

export function deleteReleaseGroupsForArtist(artistMbid: string): void {
  const db = getDb();
  db.query("DELETE FROM catalog_release_groups WHERE artist_mbid = ?").run(
    artistMbid
  );
}

export function getCatalogStats(): {
  totalArtists: number;
  totalReleaseGroups: number;
  freshArtists: number;
  staleArtists: number;
  uncheckedArtists: number;
} {
  const db = getDb();
  const total = db
    .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM catalog_artists")
    .get()?.cnt ?? 0;
  const totalRg = db
    .query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM catalog_release_groups"
    )
    .get()?.cnt ?? 0;

  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const fresh = db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM catalog_artists WHERE catalog_checked_at >= ?"
    )
    .get(thirtyDaysAgo)?.cnt ?? 0;

  const unchecked = db
    .query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM catalog_artists WHERE catalog_checked_at IS NULL"
    )
    .get()?.cnt ?? 0;

  return {
    totalArtists: total,
    totalReleaseGroups: totalRg,
    freshArtists: fresh,
    staleArtists: total - fresh - unchecked,
    uncheckedArtists: unchecked,
  };
}
