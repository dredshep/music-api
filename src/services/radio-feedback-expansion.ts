import { getDb } from "../db/database";
import * as lastfm from "./lastfm";

export interface RadioFeedbackExpansionCandidate {
  artist: string;
  title: string;
  mbid: string | null;
  score: number;
  strength: number;
  sourceArtist: string;
  sourceTitle: string;
}

interface FeedbackRow {
  entity_key: string;
  strength: number;
  station_id: string | null;
}

interface TrackIdentityRow {
  artist: string;
  title: string;
}

/**
 * Explicit More Like feedback is a taste direction, not merely a request to
 * replay the exact same recording. Resolve the rated track from saved Radio
 * history, then ask Last.fm for its neighbourhood. Calls are intentionally
 * bounded so old feedback cannot create an unbounded provider fan-out.
 */
export async function expandPositiveRadioFeedback(
  stationId: string,
  limitFeedbackItems = 8,
  similarPerItem = 24,
): Promise<{ candidates: RadioFeedbackExpansionCandidate[]; errors: string[] }> {
  const db = getDb();
  const feedback = db.query<FeedbackRow, [string, number]>(`SELECT entity_key,strength,station_id
      FROM radio_feedback
      WHERE action='more_like' AND entity_type='track'
        AND (scope='global' OR station_id=?)
      ORDER BY created_at DESC
      LIMIT ?`).all(stationId, Math.max(1, limitFeedbackItems));

  const findScoped = db.query<TrackIdentityRow, [string, string]>(`SELECT t.artist,t.title
      FROM radio_generation_tracks t
      JOIN radio_generations g ON g.id=t.generation_id
      WHERE t.canonical_key=? AND g.station_id=?
      ORDER BY g.created_at DESC,t.created_at DESC LIMIT 1`);
  const findGlobal = db.query<TrackIdentityRow, [string]>(`SELECT t.artist,t.title
      FROM radio_generation_tracks t
      JOIN radio_generations g ON g.id=t.generation_id
      WHERE t.canonical_key=?
      ORDER BY g.created_at DESC,t.created_at DESC LIMIT 1`);

  const candidates: RadioFeedbackExpansionCandidate[] = [];
  const errors: string[] = [];
  const seenSources = new Set<string>();

  for (const row of feedback) {
    if (seenSources.has(row.entity_key)) continue;
    seenSources.add(row.entity_key);
    const source = row.station_id
      ? findScoped.get(row.entity_key, row.station_id)
      : findGlobal.get(row.entity_key);
    if (!source) continue;
    try {
      const similar = await lastfm.getSimilarTracks(source.artist, source.title, similarPerItem);
      for (const track of similar) {
        candidates.push({
          artist: track.artist,
          title: track.name,
          mbid: track.mbid || null,
          score: Math.max(0.05, Math.min(1, track.match)),
          strength: Math.max(0.1, row.strength),
          sourceArtist: source.artist,
          sourceTitle: source.title,
        });
      }
    } catch (error) {
      errors.push(`More like ${source.artist} — ${source.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { candidates, errors };
}
