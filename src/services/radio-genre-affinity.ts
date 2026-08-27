export interface GenreSeedLike {
  id: string;
  seed_type: string;
}

/**
 * Genre similarity must only act on genre/tag evidence. Reusing generic seed
 * affinity made the control misleading for artist/track radios.
 */
export function radioGenreAffinity(
  seedScores: Record<string, number>,
  seeds: GenreSeedLike[],
): number {
  const genreSeedIds = new Set(seeds.filter((seed) => seed.seed_type === "genre").map((seed) => seed.id));
  let best = 0;
  for (const [seedId, score] of Object.entries(seedScores)) {
    if (!genreSeedIds.has(seedId) || !Number.isFinite(score)) continue;
    best = Math.max(best, score);
  }
  return Math.max(0, Math.min(1, best));
}
