import * as lastfm from "./lastfm";
import { normalizeForComparison } from "../domain/normalization";
import type { GradientRoutePlan, GradientRouteNode } from "./radio-gradient-route";

export interface GradientPoolTrack {
  artist: string;
  title: string;
  mbid: string | null;
  routePosition: number;
  routeConfidence: number;
  routeArtist: string;
  providerScore: number;
  source: "route_artist" | "route_neighbor";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function key(artist: string, title: string) {
  return `${normalizeForComparison(artist)}|${normalizeForComparison(title)}`;
}

function localSpacing(nodes: GradientRouteNode[], index: number) {
  const current = nodes[index]!;
  const before = index > 0 ? current.position - nodes[index - 1]!.position : Infinity;
  const after = index + 1 < nodes.length ? nodes[index + 1]!.position - current.position : Infinity;
  const finite = [before, after].filter(Number.isFinite);
  return finite.length ? Math.max(0.03, Math.min(...finite)) : 0.2;
}

/**
 * Populate each discovered route region with actual recordings. The route is
 * artist-level on purpose: an intermediate artist does not need direct endpoint
 * similarity. Track choice is a later, local problem and is further refined by
 * the DJ sequencer after playback identities/audio features are resolved.
 */
export async function buildGradientRouteTrackPool(
  plan: GradientRoutePlan | null,
  requestedLength: number,
): Promise<{ tracks: GradientPoolTrack[]; errors: string[] }> {
  if (!plan?.usable) return { tracks: [], errors: [] };
  const errors: string[] = [];
  const output = new Map<string, GradientPoolTrack>();
  const nodes = plan.nodes;
  const perNode = clamp(Math.ceil(requestedLength / Math.max(1, nodes.length)) + 5, 7, 28);

  const add = (track: GradientPoolTrack) => {
    const id = key(track.artist, track.title);
    if (!id.includes("|")) return;
    const current = output.get(id);
    if (!current || track.providerScore * track.routeConfidence > current.providerScore * current.routeConfidence) {
      output.set(id, track);
    }
  };

  for (let offset = 0; offset < nodes.length; offset += 4) {
    const batch = nodes.slice(offset, offset + 4);
    const rows = await Promise.all(batch.map(async (node) => {
      try {
        const tracks = await lastfm.getArtistTopTracks(node.artist, perNode);
        return { node, tracks, error: null as string | null };
      } catch (error) {
        return { node, tracks: [] as lastfm.LastFmTrack[], error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const row of rows) {
      if (row.error) errors.push(`Gradient route ${row.node.artist}: ${row.error}`);
      for (const track of row.tracks) {
        add({
          artist: track.artist || row.node.artist,
          title: track.name,
          mbid: track.mbid || null,
          routePosition: row.node.position,
          routeConfidence: row.node.confidence,
          routeArtist: row.node.artist,
          providerScore: clamp(0.3 + track.match * 0.7, 0.2, 1),
          source: "route_artist",
        });
      }
    }
  }

  // Scenic mode deliberately samples a little territory around interior route
  // nodes. These are local detours, not endpoint recommendations: their musical
  // coordinate is inherited from the route region they are adjacent to.
  if (plan.algorithm === "scenic") {
    const interior = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.kind === "bridge")
      .slice(0, 8);
    for (let offset = 0; offset < interior.length; offset += 3) {
      const batch = interior.slice(offset, offset + 3);
      const neighbors = await Promise.all(batch.map(async ({ node, index }) => {
        try {
          return { node, index, rows: await lastfm.getSimilarArtists(node.artist, 4), error: null as string | null };
        } catch (error) {
          return { node, index, rows: [] as lastfm.LastFmSimilarArtist[], error: error instanceof Error ? error.message : String(error) };
        }
      }));
      for (const item of neighbors) {
        if (item.error) errors.push(`Gradient scenic ${item.node.artist}: ${item.error}`);
        const spacing = localSpacing(nodes, item.index);
        const useful = item.rows.filter((row) => row.match >= 0.08).slice(0, 2);
        const trackRows = await Promise.all(useful.map(async (neighbor, neighborIndex) => {
          try {
            return { neighbor, neighborIndex, tracks: await lastfm.getArtistTopTracks(neighbor.name, Math.min(7, perNode)), error: null as string | null };
          } catch (error) {
            return { neighbor, neighborIndex, tracks: [] as lastfm.LastFmTrack[], error: error instanceof Error ? error.message : String(error) };
          }
        }));
        for (const row of trackRows) {
          if (row.error) errors.push(`Gradient scenic ${row.neighbor.name}: ${row.error}`);
          const direction = row.neighborIndex % 2 === 0 ? -1 : 1;
          const routePosition = clamp(item.node.position + direction * spacing * 0.12, 0, 1);
          const confidence = clamp(item.node.confidence * row.neighbor.match * 0.85, 0.05, 0.9);
          for (const track of row.tracks) {
            add({
              artist: track.artist || row.neighbor.name,
              title: track.name,
              mbid: track.mbid || null,
              routePosition,
              routeConfidence: confidence,
              routeArtist: item.node.artist,
              providerScore: clamp((0.25 + track.match * 0.65) * Math.max(0.25, row.neighbor.match), 0.08, 0.85),
              source: "route_neighbor",
            });
          }
        }
      }
    }
  }

  return { tracks: [...output.values()], errors };
}
