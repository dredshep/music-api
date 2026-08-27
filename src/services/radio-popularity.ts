export interface PopularityCandidateLike {
  metadata: Record<string, unknown>;
}

/**
 * Normalize only real popularity evidence. Provider similarity/ranking is not
 * popularity and must never be reused for the Popular ↔ Obscure control.
 * Existing normalized provider popularity (for example Spotify 0..1) wins;
 * Last.fm playcounts are log-scaled within the candidate pool.
 */
export function normalizeRadioPopularity<T extends PopularityCandidateLike>(candidates: T[]): T[] {
  const playcounts = candidates
    .map((candidate) => candidate.metadata.lastfmPlaycount)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const maxLog = playcounts.length ? Math.max(...playcounts.map((value) => Math.log1p(value))) : 0;

  for (const candidate of candidates) {
    if (typeof candidate.metadata.popularity === "number" && Number.isFinite(candidate.metadata.popularity)) {
      candidate.metadata.popularity = Math.max(0, Math.min(1, candidate.metadata.popularity));
      continue;
    }
    const playcount = candidate.metadata.lastfmPlaycount;
    if (typeof playcount === "number" && Number.isFinite(playcount) && playcount > 0 && maxLog > 0) {
      candidate.metadata.popularity = Math.log1p(playcount) / maxLog;
    }
  }
  return candidates;
}
