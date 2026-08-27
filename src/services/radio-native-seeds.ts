import { getDb } from "../db/database";
import { getSeeds, type RadioSeedInput } from "../db/repositories/radio";
import * as navidrome from "./navidrome";

const DEFAULT_LIBRARY_SAMPLE_SIZE = 200;

type LibrarySampler = (size: number) => Promise<navidrome.LibrarySong[]>;

function sampledTracks(songs: navidrome.LibrarySong[]) {
  return songs.map((song) => ({
    artist: song.artist,
    title: song.title,
    album: song.album || null,
    durationMs: Math.max(0, Math.round(song.duration * 1000)),
    releaseYear: song.year ?? null,
    navidromeId: song.id,
    weight: 1,
  }));
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
}

/**
 * Resolve backend-owned Radio seed types before they are persisted.
 * A `library` seed always means the Navidrome library; clients must not supply
 * a substitute snapshot (for example Spotify Likes) for that semantic seed.
 */
export async function hydrateNativeRadioSeeds(
  seeds: RadioSeedInput[],
  sampleLibrary: LibrarySampler = navidrome.getRandomSongs,
): Promise<RadioSeedInput[]> {
  if (!seeds.some((seed) => seed.type === "library")) return seeds;

  const tracks = sampledTracks(await sampleLibrary(DEFAULT_LIBRARY_SAMPLE_SIZE));
  return seeds.map((seed) => seed.type === "library"
    ? {
        ...seed,
        metadata: {
          ...(seed.metadata ?? {}),
          source: "navidrome_library",
          tracks,
        },
      }
    : seed);
}

/** Refresh a saved `library` seed so Generate Again sees the current local library. */
export async function refreshNativeRadioSeedSnapshots(
  stationId: string,
  sampleLibrary: LibrarySampler = navidrome.getRandomSongs,
): Promise<number> {
  const seeds = getSeeds(stationId).filter((seed) => seed.seed_type === "library");
  if (!seeds.length) return 0;

  const tracks = sampledTracks(await sampleLibrary(DEFAULT_LIBRARY_SAMPLE_SIZE));
  const stmt = getDb().query("UPDATE radio_station_seeds SET metadata_json=? WHERE id=? AND station_id=?");
  getDb().transaction(() => {
    for (const seed of seeds) {
      stmt.run(JSON.stringify({
        ...parseMetadata(seed.metadata_json),
        source: "navidrome_library",
        tracks,
      }), seed.id, stationId);
    }
  })();
  return seeds.length;
}
