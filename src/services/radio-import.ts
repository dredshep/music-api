import { canonicalRadioTrackKey, presentGeneration } from "./radio";
import { getDb } from "../db/database";
import { normalizeForComparison } from "../domain/normalization";
import * as navidrome from "./navidrome";
import {
  finishGeneration,
  getGeneration,
  replaceGenerationTracks,
  snapshotGeneration,
  type RadioTrackRow,
} from "../db/repositories/radio";

export interface ExternalRadioTrack {
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  spotifyId?: string | null;
  navidromeId?: string | null;
  isrc?: string | null;
}

type LocalResolver = (tracks: ExternalRadioTrack[]) => Promise<ExternalRadioTrack[]>;

async function resolveLocalTracks(tracks: ExternalRadioTrack[]): Promise<ExternalRadioTrack[]> {
  const resolved = tracks.map((track) => ({ ...track }));
  for (let i = 0; i < resolved.length; i += 12) {
    await Promise.all(resolved.slice(i, i + 12).map(async (track) => {
      if (track.navidromeId) return;
      try {
        const result = await navidrome.search3(`${track.artist} ${track.title}`, {
          artistCount: 0,
          albumCount: 0,
          songCount: 8,
        });
        const best = result.songs.find((song) =>
          normalizeForComparison(song.artist) === normalizeForComparison(track.artist) &&
          normalizeForComparison(song.title) === normalizeForComparison(track.title)
        );
        if (!best) return;
        track.navidromeId = best.id;
        track.album ||= best.album || null;
        track.durationMs ||= Math.max(0, Math.round(best.duration * 1000));
      } catch {
        // External import remains valid even when Navidrome is temporarily unavailable.
      }
    }));
  }
  return resolved;
}

/**
 * Explicitly replace a generation with an imported external playlist. This is
 * intentionally never automatic: the current generation is snapshotted first.
 * Local Navidrome matches remain the preferred playback source after import.
 */
export async function importExternalGeneration(
  generationId: string,
  tracks: ExternalRadioTrack[],
  resolveLocal: LocalResolver = resolveLocalTracks,
) {
  const generation = getGeneration(generationId);
  if (!generation) return null;

  const resolvedTracks = await resolveLocal(tracks);
  snapshotGeneration(generationId, "external_playlist_import");
  const rows: Array<Omit<RadioTrackRow, "id" | "generation_id" | "created_at" | "position">> = resolvedTracks.map((track) => ({
    canonical_key: canonicalRadioTrackKey(track.artist, track.title),
    artist: track.artist,
    title: track.title,
    album: track.album ?? null,
    duration_ms: track.durationMs ?? null,
    isrc: track.isrc ?? null,
    spotify_id: track.spotifyId ?? null,
    navidrome_id: track.navidromeId ?? null,
    musicbrainz_id: null,
    playback_source: track.navidromeId ? "navidrome" : track.spotifyId ? "spotify" : null,
    availability_status: track.navidromeId ? "local" : track.spotifyId ? "spotify" : "unavailable",
    pinned: 0,
    manual: 1,
    selection_score: 0,
    trajectory_position: null,
    metadata_json: JSON.stringify({ importedFromExternalPlaylist: true }),
  }));
  replaceGenerationTracks(generationId, rows);
  getDb().query("UPDATE radio_generations SET requested_length=? WHERE id=?").run(resolvedTracks.length, generationId);
  finishGeneration(generationId, "ready", {
    imported_external_playlist: true,
    imported_track_count: resolvedTracks.length,
    local_match_count: resolvedTracks.filter((track) => Boolean(track.navidromeId)).length,
  });
  return presentGeneration(generationId);
}
