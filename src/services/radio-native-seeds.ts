import type { RadioSeedInput } from "../db/repositories/radio";
import * as navidrome from "./navidrome";

const DEFAULT_LIBRARY_SAMPLE_SIZE = 200;

type LibrarySampler = (size: number) => Promise<navidrome.LibrarySong[]>;

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

  const songs = await sampleLibrary(DEFAULT_LIBRARY_SAMPLE_SIZE);
  const tracks = songs.map((song) => ({
    artist: song.artist,
    title: song.title,
    album: song.album || null,
    durationMs: Math.max(0, Math.round(song.duration * 1000)),
    releaseYear: song.year ?? null,
    navidromeId: song.id,
    weight: 1,
  }));

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
