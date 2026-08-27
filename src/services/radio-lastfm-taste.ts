import * as lastfm from "./lastfm";
import { normalizeForComparison } from "../domain/normalization";

export interface LastFmTasteWeight {
  recent: number;
  historical: number;
}

type TopTracksFetcher = typeof lastfm.getUserTopTracks;

const WINDOWS: Array<{ period: lastfm.LastFmPeriod; weight: number; limit: number }> = [
  { period: "1month", weight: 1.0, limit: 180 },
  { period: "3month", weight: 0.9, limit: 220 },
  { period: "6month", weight: 0.78, limit: 250 },
  { period: "12month", weight: 0.62, limit: 300 },
];

function key(artist: string, title: string) {
  return `text:${normalizeForComparison(artist)}|${normalizeForComparison(title)}`;
}

/**
 * Last.fm exposes rolling top-track windows rather than an efficient complete
 * event history query. Approximate continuous time decay by taking the strongest
 * weighted signal from nested recent windows, while retaining the overall score
 * separately as long-term taste. Recent years therefore matter substantially
 * more without deleting older listening history.
 */
export async function buildLastFmTasteMap(
  fetchTopTracks: TopTracksFetcher = lastfm.getUserTopTracks,
): Promise<Map<string, LastFmTasteWeight>> {
  const map = new Map<string, LastFmTasteWeight>();

  for (const window of WINDOWS) {
    const tracks = await fetchTopTracks(window.period, window.limit).catch(() => []);
    for (const track of tracks) {
      const candidateKey = key(track.artist, track.name);
      const row = map.get(candidateKey) ?? { recent: 0, historical: 0 };
      row.recent = Math.max(row.recent, Math.max(0, Math.min(1, track.match)) * window.weight);
      map.set(candidateKey, row);
    }
  }

  const historical = await fetchTopTracks("overall", 350).catch(() => []);
  for (const track of historical) {
    const candidateKey = key(track.artist, track.name);
    const row = map.get(candidateKey) ?? { recent: 0, historical: 0 };
    row.historical = Math.max(row.historical, Math.max(0, Math.min(1, track.match)));
    map.set(candidateKey, row);
  }

  return map;
}
