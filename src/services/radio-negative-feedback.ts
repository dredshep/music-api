import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import * as lastfm from "./lastfm";

type SimilarTrackProvider = typeof lastfm.getSimilarTracks;

interface FeedbackRow {
  entity_key: string;
  strength: number;
  station_id: string | null;
}

interface TrackIdentityRow {
  artist: string;
  title: string;
}

function key(artist: string, title: string) {
  return `text:${normalizeForComparison(artist)}|${normalizeForComparison(title)}`;
}

/**
 * Less Like is intentionally soft: it suppresses the rated track directly via
 * normal feedback scoring, and also applies bounded penalties to its Last.fm
 * neighbourhood when those tracks independently enter the candidate pool.
 */
export async function buildNegativeRadioFeedbackPenalties(
  stationId: string,
  limitFeedbackItems = 8,
  similarPerItem = 24,
  getSimilarTracks: SimilarTrackProvider = lastfm.getSimilarTracks,
): Promise<{ penalties: Map<string, number>; errors: string[] }> {
  const db = getDb();
  const feedback = db.query<FeedbackRow, [string, number]>(`SELECT entity_key,strength,station_id
      FROM radio_feedback
      WHERE action='less_like' AND entity_type='track'
        AND (scope='global' OR station_id=?)
      ORDER BY created_at DESC
      LIMIT ?`).all(stationId, Math.max(1, limitFeedbackItems));
  const findScoped = db.query<TrackIdentityRow, [string, string]>(`SELECT t.artist,t.title
      FROM radio_generation_tracks t JOIN radio_generations g ON g.id=t.generation_id
      WHERE t.canonical_key=? AND g.station_id=?
      ORDER BY g.created_at DESC,t.created_at DESC LIMIT 1`);
  const findGlobal = db.query<TrackIdentityRow, [string]>(`SELECT t.artist,t.title
      FROM radio_generation_tracks t JOIN radio_generations g ON g.id=t.generation_id
      WHERE t.canonical_key=? ORDER BY g.created_at DESC,t.created_at DESC LIMIT 1`);

  const penalties = new Map<string, number>();
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const row of feedback) {
    if (seen.has(row.entity_key)) continue;
    seen.add(row.entity_key);
    const source = row.station_id ? findScoped.get(row.entity_key, row.station_id) : findGlobal.get(row.entity_key);
    if (!source) continue;
    try {
      const similar = await getSimilarTracks(source.artist, source.title, similarPerItem);
      for (const track of similar) {
        const candidateKey = key(track.artist, track.name);
        const penalty = Math.max(0.05, Math.min(1, track.match)) * Math.max(0.1, row.strength) * 0.55;
        penalties.set(candidateKey, Math.max(penalties.get(candidateKey) ?? 0, penalty));
      }
    } catch (error) {
      errors.push(`Less like ${source.artist} — ${source.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { penalties, errors };
}
