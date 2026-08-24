import { artistMatch, titleMatch } from "./normalization";
import type { LibrarySong } from "../services/navidrome";

export type TrackOwnershipStatus = "owned" | "uncertain" | "missing";

export type TrackOwnershipQuery = {
  artist: string;
  title: string;
  album?: string;
  durationMs?: number;
};

export type TrackOwnershipMatch = {
  navidromeId: string;
  artist: string;
  title: string;
  album: string;
  durationMs: number;
  confidence: number;
  reasons: string[];
};

export type TrackOwnershipResult = {
  status: TrackOwnershipStatus;
  confidence: number;
  match: TrackOwnershipMatch | null;
};

function scoreSong(query: TrackOwnershipQuery, song: LibrarySong): TrackOwnershipMatch {
  const artist = artistMatch(query.artist, song.artist);
  const title = titleMatch(query.title, song.title);
  const reasons: string[] = [];

  let score = title.confidence * 0.55 + artist.confidence * 0.35;
  if (title.match) reasons.push(title.reason);
  if (artist.match) reasons.push(artist.reason);

  if (query.album && song.album) {
    const album = titleMatch(query.album, song.album);
    if (album.match) {
      score += album.confidence * 0.05;
      reasons.push("album_match");
    }
  }

  if (query.durationMs && song.duration > 0) {
    const differenceSeconds = Math.abs(query.durationMs / 1000 - song.duration);
    if (differenceSeconds <= 2) {
      score += 0.1;
      reasons.push("duration_exact");
    } else if (differenceSeconds <= 5) {
      score += 0.08;
      reasons.push("duration_close");
    } else if (differenceSeconds <= 10) {
      score += 0.04;
      reasons.push("duration_near");
    } else if (differenceSeconds > 30) {
      score -= 0.12;
      reasons.push("duration_mismatch");
    }
  }

  // A strong title match with a weak artist (or vice versa) should never become
  // an owned result just because duration/album happen to line up.
  if (!title.match) score = Math.min(score, 0.79);
  if (!artist.match) score = Math.min(score, 0.84);

  const confidence = Math.max(0, Math.min(1, score));
  return {
    navidromeId: song.id,
    artist: song.artist,
    title: song.title,
    album: song.album,
    durationMs: Math.round(song.duration * 1000),
    confidence,
    reasons,
  };
}

export function matchLibraryTrack(
  query: TrackOwnershipQuery,
  songs: LibrarySong[]
): TrackOwnershipResult {
  const matches = songs
    .map((song) => scoreSong(query, song))
    .sort((a, b) => b.confidence - a.confidence);

  const best = matches[0] ?? null;
  const confidence = best?.confidence ?? 0;

  if (confidence >= 0.9) return { status: "owned", confidence, match: best };
  if (confidence >= 0.72) return { status: "uncertain", confidence, match: best };
  return { status: "missing", confidence, match: best };
}
