import * as musicbrainz from "./musicbrainz";

export type RadioMusicBrainzSeed = {
  id: string;
  seed_type: string;
  artist: string | null;
  title: string | null;
  label: string;
  weight: number;
};

export type RadioMusicBrainzCandidate = {
  artist: string;
  title: string;
  recordingMbid: string;
  score: number;
  seedId: string;
  seedWeight: number;
  releaseYear: number | null;
};

export const MAX_MUSICBRAINZ_RADIO_QUERIES = 3;

function quote(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function musicBrainzQueryForRadioSeed(seed: RadioMusicBrainzSeed): string | null {
  if (seed.seed_type === "track" && seed.artist && seed.title) {
    return `recording:${quote(seed.title)} AND artist:${quote(seed.artist)}`;
  }
  if (seed.seed_type === "artist" && seed.artist) {
    return `artist:${quote(seed.artist)}`;
  }
  if (seed.seed_type === "album" && seed.artist && (seed.title || seed.label)) {
    return `release:${quote(seed.title || seed.label)} AND artist:${quote(seed.artist)}`;
  }
  if (seed.seed_type === "genre") {
    return `tag:${quote(seed.label)}`;
  }
  return null;
}

export function planMusicBrainzRadioQueries(seeds: RadioMusicBrainzSeed[]) {
  const seen = new Set<string>();
  return seeds
    .map((seed, index) => ({ seed, index, query: musicBrainzQueryForRadioSeed(seed) }))
    .filter((row): row is { seed: RadioMusicBrainzSeed; index: number; query: string } => Boolean(row.query))
    .sort((a, b) => b.seed.weight - a.seed.weight || a.index - b.index)
    .filter((row) => {
      if (seen.has(row.query)) return false;
      seen.add(row.query);
      return true;
    })
    .slice(0, MAX_MUSICBRAINZ_RADIO_QUERIES);
}

/**
 * MusicBrainz is metadata/relationship-oriented rather than a recommendation
 * service, so it is intentionally a low-weight independent candidate source.
 * Queries are deduplicated and capped to three weighted seeds so the provider's
 * strict rate limit cannot make a many-seed Radio several seconds slower.
 */
export async function getMusicBrainzRadioCandidates(
  seeds: RadioMusicBrainzSeed[],
  enabled = true,
): Promise<{ candidates: RadioMusicBrainzCandidate[]; errors: string[] }> {
  if (!enabled) return { candidates: [], errors: [] };
  const candidates: RadioMusicBrainzCandidate[] = [];
  const errors: string[] = [];

  for (const { seed, query } of planMusicBrainzRadioQueries(seeds)) {
    try {
      const rows = await musicbrainz.searchRecordings(query, seed.seed_type === "artist" ? 35 : 20);
      for (const row of rows) {
        const score = Math.max(0.05, Math.min(1, row.score / 100));
        const releaseYear = row.firstReleaseDate?.match(/^\d{4}/)?.[0];
        candidates.push({
          artist: row.artistCredit,
          title: row.title,
          recordingMbid: row.id,
          score,
          seedId: seed.id,
          seedWeight: Math.max(0.01, seed.weight),
          releaseYear: releaseYear ? Number(releaseYear) : null,
        });
      }
    } catch (error) {
      errors.push(`MusicBrainz ${seed.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { candidates, errors };
}
