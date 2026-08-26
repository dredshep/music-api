/**
 * Read-only access to slskd's SQLite databases (transfers.db, messaging.db).
 *
 * These DBs are mounted read-only into the music-api container.
 * Music Manager previously accessed them directly; now music-api
 * provides the data through Manager API endpoints.
 */

import { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { log } from "../middleware/logging";
import { existsSync } from "node:fs";

let _transfersDb: Database | null = null;
let _messagingDb: Database | null = null;
let _transfersChecked = false;
let _messagingChecked = false;

function openReadOnly(path: string): Database | null {
  if (!path || !existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA query_only = ON");
    return db;
  } catch (err) {
    log("warn", "slskd_db_open_failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getTransfersDb(): Database | null {
  if (!_transfersChecked) {
    _transfersChecked = true;
    _transfersDb = openReadOnly(getConfig().SLSKD_TRANSFERS_DB_PATH);
  }
  return _transfersDb;
}

function getMessagingDb(): Database | null {
  if (!_messagingChecked) {
    _messagingChecked = true;
    _messagingDb = openReadOnly(getConfig().SLSKD_MESSAGING_DB_PATH);
  }
  return _messagingDb;
}

export function isTransfersDbAvailable(): boolean {
  return getTransfersDb() !== null;
}

export function isMessagingDbAvailable(): boolean {
  return getMessagingDb() !== null;
}

// --- Transfer types ---

export interface SoulseekTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  bytesTransferred: number;
  averageSpeed: number;
  stateDescription: string;
  placeInQueue: number | null;
  direction: string;
  requestedAt: string | null;
  endedAt: string | null;
}

export interface TransferOverview {
  overview: Array<{
    direction: string;
    transfers: number;
    bytes: number;
    users: number;
  }>;
  averageUploadSpeed: number;
  active: Array<{ state: string; direction: string; count: number }>;
}

export interface PeerSummary {
  username: string;
  transfers: number;
  bytes: number;
  days: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface SoulMessage {
  username: string;
  timestamp: string;
  direction: "inbound" | "outbound";
  message: string;
}

// --- Transfer history queries ---

export function transferHistory(opts: {
  direction?: "Download" | "Upload";
  limit?: number;
  username?: string;
  search?: string;
} = {}): SoulseekTransfer[] {
  const db = getTransfersDb();
  if (!db) return [];

  const where = ["Removed=0", "Direction=?"];
  const params: Array<string | number> = [opts.direction ?? "Download"];

  if (opts.username) {
    where.push("Username=?");
    params.push(opts.username);
  }
  if (opts.search) {
    where.push("Filename LIKE ?");
    params.push(`%${opts.search}%`);
  }

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  params.push(limit);

  return db
    .query<SoulseekTransfer, Array<string | number>>(
      `SELECT Id as id, Username as username, Filename as filename,
       Size as size, BytesTransferred as bytesTransferred,
       AverageSpeed as averageSpeed, StateDescription as stateDescription,
       PlaceInQueue as placeInQueue, Direction as direction,
       RequestedAt as requestedAt, EndedAt as endedAt
       FROM Transfers WHERE ${where.join(" AND ")}
       ORDER BY RequestedAt DESC LIMIT ?`
    )
    .all(...params);
}

export function soulseekOverview(): TransferOverview | null {
  const db = getTransfersDb();
  if (!db) return null;

  const overview = db
    .query<
      { direction: string; transfers: number; bytes: number; users: number },
      []
    >(
      `SELECT Direction as direction, COUNT(*) as transfers,
       COALESCE(SUM(Size),0) as bytes, COUNT(DISTINCT Username) as users
       FROM Transfers WHERE Removed=0 AND StateDescription='Completed, Succeeded'
       GROUP BY Direction`
    )
    .all();

  const avg = db
    .query<{ speed: number }, []>(
      `SELECT COALESCE(AVG(AverageSpeed),0) as speed FROM Transfers
       WHERE Direction='Upload' AND StateDescription='Completed, Succeeded'
       AND AverageSpeed>0`
    )
    .get() ?? { speed: 0 };

  const active = db
    .query<{ state: string; direction: string; count: number }, []>(
      `SELECT StateDescription as state, Direction as direction, COUNT(*) as count
       FROM Transfers WHERE Removed=0
       AND StateDescription IN ('InProgress','Queued, Remotely','Initializing')
       GROUP BY StateDescription, Direction`
    )
    .all();

  return { overview, averageUploadSpeed: avg.speed, active };
}

export function stateBreakdown(
  direction: "Upload" | "Download"
): Array<{ state: string; count: number }> {
  const db = getTransfersDb();
  if (!db) return [];

  return db
    .query<{ state: string; count: number }, [string]>(
      `SELECT StateDescription as state, COUNT(*) as count FROM Transfers
       WHERE Direction=? AND Removed=0
       GROUP BY StateDescription ORDER BY count DESC`
    )
    .all(direction);
}

export function soulseekStats(): Array<{
  direction: string;
  transfers: number;
  bytes: number;
  users: number;
}> | null {
  const db = getTransfersDb();
  if (!db) return null;

  return db
    .query<
      { direction: string; transfers: number; bytes: number; users: number },
      []
    >(
      `SELECT Direction as direction, COUNT(*) as transfers,
       COALESCE(SUM(Size),0) as bytes, COUNT(DISTINCT Username) as users
       FROM Transfers WHERE Removed=0 AND StateDescription='Completed, Succeeded'
       GROUP BY Direction`
    )
    .all();
}

const SUCCESS_UPLOAD =
  "Direction='Upload' AND StateDescription='Completed, Succeeded'";

export function topPeers(limit = 100): PeerSummary[] {
  const db = getTransfersDb();
  if (!db) return [];

  return db
    .query<PeerSummary, [number]>(
      `SELECT Username as username, COUNT(*) as transfers,
       COALESCE(SUM(Size),0) as bytes,
       COUNT(DISTINCT date(COALESCE(EndedAt,RequestedAt))) as days,
       MIN(COALESCE(EndedAt,RequestedAt)) as firstSeen,
       MAX(COALESCE(EndedAt,RequestedAt)) as lastSeen
       FROM Transfers WHERE ${SUCCESS_UPLOAD} AND Removed=0
       GROUP BY Username ORDER BY bytes DESC LIMIT ?`
    )
    .all(limit);
}

const AUDIO_FILTER = [
  "mp3", "flac", "wav", "aac", "m4a", "ogg", "opus", "wma", "aiff", "alac",
  "ape", "wv", "dsf", "dff",
]
  .map((ext) => `LOWER(Filename) LIKE '%.${ext}'`)
  .join(" OR ");

function categorizeUser(
  days: number,
  tracks: number,
  bytes: number
): string {
  if (days >= 10) return "Extreme / persistent regular";
  if (days >= 5) return "Genuine regular";
  if (days >= 3) return "Occasional → regular";
  if (days === 2) return "Occasional repeat";
  if (days === 1 && (tracks >= 50 || bytes >= 2e9)) return "One-day binge";
  if (days === 1) return "One-off";
  return "Unknown";
}

export function peerAnalytics(username: string) {
  const db = getTransfersDb();
  if (!db) return null;

  const summary = db
    .query<
      {
        transfers: number;
        uniqueFiles: number;
        tracks: number;
        bytes: number;
        days: number;
        firstSeen: string | null;
        lastSeen: string | null;
      },
      [string]
    >(
      `SELECT COUNT(*) as transfers, COUNT(DISTINCT Filename) as uniqueFiles,
       SUM(CASE WHEN ${AUDIO_FILTER} THEN 1 ELSE 0 END) as tracks,
       COALESCE(SUM(Size),0) as bytes,
       COUNT(DISTINCT date(COALESCE(EndedAt,RequestedAt))) as days,
       MIN(COALESCE(EndedAt,RequestedAt)) as firstSeen,
       MAX(COALESCE(EndedAt,RequestedAt)) as lastSeen
       FROM Transfers WHERE Username=? AND ${SUCCESS_UPLOAD}`
    )
    .get(username);

  if (!summary) return null;

  const unique = db
    .query<{ bytes: number }, [string]>(
      `SELECT COALESCE(SUM(sz),0) as bytes FROM
       (SELECT MAX(Size) as sz FROM Transfers
       WHERE Username=? AND ${SUCCESS_UPLOAD} GROUP BY Filename)`
    )
    .get(username) ?? { bytes: 0 };

  const session = db
    .query<{ sessions: number }, [string]>(
      `WITH ordered AS (
        SELECT datetime(COALESCE(EndedAt,RequestedAt)) as ts
        FROM Transfers WHERE Username=? AND ${SUCCESS_UPLOAD} ORDER BY ts
      ), flagged AS (
        SELECT ts, CASE
          WHEN LAG(ts) OVER (ORDER BY ts) IS NULL THEN 1
          WHEN (julianday(ts)-julianday(LAG(ts) OVER (ORDER BY ts)))*1440>45 THEN 1
          ELSE 0 END as is_new FROM ordered
      ) SELECT COALESCE(SUM(is_new),0) as sessions FROM flagged`
    )
    .get(username) ?? { sessions: 0 };

  const downloads = db
    .query<{ count: number; bytes: number }, [string]>(
      `SELECT COUNT(*) as count, COALESCE(SUM(Size),0) as bytes
       FROM Transfers WHERE Username=? AND Direction='Download'
       AND StateDescription='Completed, Succeeded'`
    )
    .get(username) ?? { count: 0, bytes: 0 };

  const topArtists = db
    .query<
      { artist: string; files: number; bytes: number; days: number },
      [string]
    >(
      `SELECT artist, COUNT(*) as files, SUM(Size) as bytes,
       COUNT(DISTINCT date(COALESCE(EndedAt,RequestedAt))) as days
       FROM (SELECT Size, EndedAt, RequestedAt,
         SUBSTR(REPLACE(Filename,'/','\\\\'),LENGTH('music\\\\')+1,
         INSTR(SUBSTR(REPLACE(Filename,'/','\\\\'),LENGTH('music\\\\')+1),'\\\\')-1) as artist
       FROM Transfers WHERE Username=? AND ${SUCCESS_UPLOAD})
       WHERE artist IS NOT NULL AND artist!=''
       GROUP BY artist ORDER BY bytes DESC LIMIT 12`
    )
    .all(username);

  const states = db
    .query<{ state: string; count: number }, [string]>(
      `SELECT StateDescription as state, COUNT(*) as count
       FROM Transfers WHERE Username=? AND Direction='Upload' AND Removed=0
       GROUP BY StateDescription ORDER BY count DESC`
    )
    .all(username);

  const repeatBytes = Math.max(0, summary.bytes - unique.bytes);
  const msgs = messagesForUser(username);

  return {
    summary: {
      ...summary,
      sessions: session.sessions,
      uniqueBytes: unique.bytes,
      repeatBytes,
      repeatPct: summary.bytes ? (repeatBytes / summary.bytes) * 100 : 0,
      category: categorizeUser(summary.days, summary.tracks, summary.bytes),
    },
    downloads,
    topArtists,
    states,
    daily: [],
    messages: msgs,
    hasThanks: msgs.some((m) =>
      /thanks?|thank you|thx|\bty\b|merci|gracias/i.test(m.message)
    ),
  };
}

// --- Messaging queries ---

export function messagesForUser(username: string): SoulMessage[] {
  const db = getMessagingDb();
  if (!db) return [];

  const rows = db
    .query<
      { username: string; timestamp: string; direction: number; message: string | null },
      [string]
    >(
      `SELECT Username as username, Timestamp as timestamp,
       Direction as direction, Message as message
       FROM PrivateMessages WHERE Username=?
       ORDER BY Timestamp DESC LIMIT 500`
    )
    .all(username);

  return rows.map((r) => ({
    username: r.username,
    timestamp: r.timestamp,
    direction: r.direction === 1 ? "inbound" as const : "outbound" as const,
    message: r.message ?? "",
  }));
}

export function recentMessages(limit = 300): SoulMessage[] {
  const db = getMessagingDb();
  if (!db) return [];

  const rows = db
    .query<
      { username: string; timestamp: string; direction: number; message: string | null },
      [number]
    >(
      `SELECT Username as username, Timestamp as timestamp,
       Direction as direction, Message as message
       FROM PrivateMessages ORDER BY Timestamp DESC LIMIT ?`
    )
    .all(limit);

  return rows.map((r) => ({
    username: r.username,
    timestamp: r.timestamp,
    direction: r.direction === 1 ? "inbound" as const : "outbound" as const,
    message: r.message ?? "",
  }));
}
