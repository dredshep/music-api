import { canonicalRadioTrackKey, presentGeneration } from "./radio";
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

/**
 * Explicitly replace a generation with an imported external playlist. This is
 * intentionally never automatic: the current generation is snapshotted first.
 */
export function importExternalGeneration(generationId: string, tracks: ExternalRadioTrack[]) {
  const generation = getGeneration(generationId);
  if (!generation) return null;
  snapshotGeneration(generationId, "external_playlist_import");
  const rows: Array<Omit<RadioTrackRow, "id" | "generation_id" | "created_at" | "position">> = tracks.map((track) => ({
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
  finishGeneration(generationId, "ready", {
    imported_external_playlist: true,
    imported_track_count: tracks.length,
  });
  return presentGeneration(generationId);
}
