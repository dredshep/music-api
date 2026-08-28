import { getConfig } from "../config";
import { getDb } from "../db/database";
import { getGenerationTracks } from "../db/repositories/radio";
import { normalizeForComparison } from "../domain/normalization";
import * as navidrome from "./navidrome";
import { presentGeneration } from "./radio";
import { primaryRadioArtistCredit, radioArtistCreditMatches } from "./radio-artist-credit";

type LocalSearch = typeof navidrome.search3;

export function localRadioSearchQueries(artist: string, title: string) {
  const primary = primaryRadioArtistCredit(artist);
  return [...new Set([
    `${artist} ${title}`,
    ...(primary && primary !== artist ? [`${primary} ${title}`] : []),
  ])];
}

/**
 * Resolve the exact selected generation against Navidrome after ranking.
 * Candidate discovery intentionally limits some pre-selection availability work;
 * this final pass guarantees every selected track gets a local lookup before the
 * generation is returned to clients or queued for audio analysis.
 */
export async function resolveRadioGenerationLocally(
  generationId: string,
  searchLocal: LocalSearch = navidrome.search3,
) {
  const tracks = getGenerationTracks(generationId).filter((track) => !track.navidrome_id);
  const updates: Array<{
    trackId: string;
    navidromeId: string;
    album: string | null;
    durationMs: number | null;
  }> = [];
  const batchSize = Math.max(1, Math.min(20, getConfig().MAX_CONCURRENT_NAVIDROME_REQUESTS));

  for (let i = 0; i < tracks.length; i += batchSize) {
    await Promise.all(tracks.slice(i, i + batchSize).map(async (track) => {
      try {
        let best: Awaited<ReturnType<LocalSearch>>["songs"][number] | undefined;
        for (const query of localRadioSearchQueries(track.artist, track.title)) {
          const result = await searchLocal(query, {
            artistCount: 0,
            albumCount: 0,
            songCount: 8,
          });
          best = result.songs.find((song) =>
            radioArtistCreditMatches(track.artist, song.artist) &&
            normalizeForComparison(song.title) === normalizeForComparison(track.title)
          );
          if (best) break;
        }
        if (!best) return;
        updates.push({
          trackId: track.id,
          navidromeId: best.id,
          album: best.album || null,
          durationMs: Math.max(0, Math.round(best.duration * 1000)),
        });
      } catch {
        // A transient Navidrome failure must not destroy an otherwise valid Radio generation.
      }
    }));
  }

  if (updates.length) {
    const stmt = getDb().query(`UPDATE radio_generation_tracks
      SET navidrome_id=?,
          album=COALESCE(album,?),
          duration_ms=COALESCE(duration_ms,?),
          playback_source='navidrome',
          availability_status='local'
      WHERE generation_id=? AND id=?`);
    getDb().transaction(() => {
      for (const update of updates) {
        stmt.run(update.navidromeId, update.album, update.durationMs, generationId, update.trackId);
      }
    })();
  }

  return presentGeneration(generationId);
}
