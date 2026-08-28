import { describe, expect, test } from "bun:test";
import { DEFAULT_RADIO_SETTINGS, type RadioSeedRow, type RadioSettings } from "../src/db/repositories/radio";
import {
  discoverGradientArtistPath,
  discoverGradientArtistPathBetweenRegions,
  gradientSeedAnchorArtists,
  planGradientRoute,
  type GradientGraphProvider,
} from "../src/services/radio-gradient-route";

function provider(graph: Record<string, Array<[string, number]>>): GradientGraphProvider {
  return {
    async similarArtists(artist) {
      return (graph[artist] ?? []).map(([name, similarity]) => ({ name, similarity }));
    },
  };
}

function seed(id: string, artist: string, position: number): RadioSeedRow {
  return {
    id,
    station_id: "station",
    seed_type: "artist",
    entity_id: null,
    artist,
    title: null,
    label: artist,
    weight: 1,
    position,
    metadata_json: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function broadSeed(
  id: string,
  type: "library" | "liked" | "playlist" | "collection",
  label: string,
  position: number,
  artists: Array<[string, number]>,
): RadioSeedRow {
  return {
    id,
    station_id: "station",
    seed_type: type,
    entity_id: null,
    artist: null,
    title: null,
    label,
    weight: 1,
    position,
    metadata_json: JSON.stringify({
      tracks: artists.map(([artist, weight], index) => ({ artist, title: `Track ${index + 1}`, weight })),
    }),
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function settings(gradientAlgorithm: RadioSettings["gradientAlgorithm"]): RadioSettings {
  return {
    ...DEFAULT_RADIO_SETTINGS,
    gradientAlgorithm,
    providerWeights: { ...DEFAULT_RADIO_SETTINGS.providerWeights },
    djWeights: { ...DEFAULT_RADIO_SETTINGS.djWeights },
  };
}

describe("Gradient musical route planner", () => {
  test("discovers an intermediate path whose middle nodes need no direct endpoint affinity", async () => {
    const graph = provider({
      A: [["X", 0.9]],
      X: [["Y", 0.8]],
      Y: [["B", 0.9]],
      B: [["Y", 0.9]],
    });

    const discovered = await discoverGradientArtistPath("A", "B", "geodesic", graph);
    expect(discovered.path).not.toBeNull();
    expect(discovered.path!.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "A->X",
      "X->Y",
      "Y->B",
    ]);
  });

  test("discovers one bounded route between multi-anchor musical regions", async () => {
    const graph = provider({
      A1: [],
      A2: [["X", 0.9]],
      X: [["B2", 0.88]],
      B1: [],
      B2: [["X", 0.88]],
    });
    const discovered = await discoverGradientArtistPathBetweenRegions(
      ["A1", "A2"],
      ["B1", "B2"],
      "geodesic",
      graph,
    );
    expect(discovered.path).not.toBeNull();
    expect(discovered.fromArtist).toBe("A2");
    expect(discovered.toArtist).toBe("B2");
    expect(discovered.path!.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "A2->X",
      "X->B2",
    ]);
    expect(discovered.queryCount).toBeLessThanOrEqual(40);
  });

  test("broad seeds expose several representative artists instead of one arbitrary track", async () => {
    const anchors = await gradientSeedAnchorArtists(broadSeed("library", "library", "My library", 0, [
      ["A", 1],
      ["B", 3],
      ["A", 1],
      ["C", 2],
      ["D", 0.5],
      ["E", 0.1],
    ]));
    expect(anchors).toEqual(["B", "A", "C", "D"]);
  });

  test("a broad waypoint can route through a non-primary representative artist", async () => {
    const graph = provider({
      Primary: [],
      Bridgeable: [["X", 0.9]],
      X: [["B", 0.9]],
      B: [["X", 0.9]],
    });
    const plan = await planGradientRoute([
      broadSeed("library", "library", "My library", 0, [["Primary", 3], ["Bridgeable", 2]]),
      seed("b", "B", 1),
    ], settings("geodesic"), graph);
    expect(plan.usable).toBe(true);
    expect(plan.segments[0]!.fromAnchors).toEqual(["Primary", "Bridgeable"]);
    expect(plan.segments[0]!.fromArtist).toBe("Bridgeable");
    expect(plan.nodes[0]!.artist).toBe("Bridgeable");
  });

  test("assigns route coordinates from cumulative musical edge cost, not playlist slot", async () => {
    const graph = provider({
      A: [["X", 0.95]],
      X: [["Y", 0.35]],
      Y: [["B", 0.95]],
      B: [["Y", 0.95]],
    });
    const plan = await planGradientRoute([seed("a", "A", 0), seed("b", "B", 1)], settings("geodesic"), graph);
    expect(plan.usable).toBe(true);
    expect(plan.nodes[0]!.artist).toBe("A");
    expect(plan.nodes[0]!.position).toBe(0);
    expect(plan.nodes.at(-1)!.artist).toBe("B");
    expect(plan.nodes.at(-1)!.position).toBe(1);
    const x = plan.nodes.find((node) => node.artist === "X")!;
    const y = plan.nodes.find((node) => node.artist === "Y")!;
    expect(x.position).toBeGreaterThan(0);
    expect(x.position).toBeLessThan(y.position);
    expect(y.position).toBeLessThan(1);
    // The weak X→Y bridge consumes most of the path distance, so X/Y are not
    // simply placed at 1/3 and 2/3.
    expect(Math.abs(x.position - 1 / 3)).toBeGreaterThan(0.08);
    expect(Math.abs(y.position - 2 / 3)).toBeGreaterThan(0.08);
  });

  test("scenic can choose a longer locally strong route instead of the shortest path", async () => {
    const graph = provider({
      A: [["M", 0.9], ["X", 0.95]],
      M: [["B", 0.9]],
      X: [["Y", 0.95]],
      Y: [["Z", 0.95]],
      Z: [["B", 0.95]],
      B: [["M", 0.9], ["Z", 0.95]],
    });
    const shortest = await discoverGradientArtistPath("A", "B", "geodesic", graph);
    const scenic = await discoverGradientArtistPath("A", "B", "scenic", graph);
    expect(shortest.path!.keys.length).toBe(3);
    expect(scenic.path!.keys.length).toBeGreaterThan(shortest.path!.keys.length);
    expect(scenic.path!.edges.map((edge) => edge.from)).toContain("Y");
  });

  test("plans each multipoint leg inside the user supplied waypoint interval", async () => {
    const graph = provider({
      A: [["AB", 0.9]],
      AB: [["B", 0.9]],
      B: [["AB", 0.9], ["BC", 0.85]],
      BC: [["C", 0.85]],
      C: [["BC", 0.85]],
    });
    const plan = await planGradientRoute([
      seed("a", "A", 0),
      seed("b", "B", 0.3),
      seed("c", "C", 1),
    ], settings("geodesic"), graph);
    expect(plan.usable).toBe(true);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments.every((segment) => segment.connected)).toBe(true);
    const b = plan.nodes.find((node) => node.artist === "B")!;
    expect(b.position).toBeCloseTo(0.3, 5);
    const ab = plan.nodes.find((node) => node.artist === "AB")!;
    const bc = plan.nodes.find((node) => node.artist === "BC")!;
    expect(ab.position).toBeGreaterThan(0);
    expect(ab.position).toBeLessThan(0.3);
    expect(bc.position).toBeGreaterThan(0.3);
    expect(bc.position).toBeLessThan(1);
  });

  test("legacy blend explicitly opts out of graph routing", async () => {
    const plan = await planGradientRoute([seed("a", "A", 0), seed("b", "B", 1)], settings("blend"), provider({}));
    expect(plan.usable).toBe(false);
    expect(plan.algorithm).toBe("blend");
    expect(plan.nodes).toEqual([]);
  });
});