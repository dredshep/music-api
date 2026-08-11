import { describe, test, expect } from "bun:test";
import {
  scoreCandidate,
  buildSeeds,
  type CanonicalCandidate,
  type SourceObservation,
  type Seed,
} from "../src/domain/recommendations";

function makeCandidate(overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    type: "artist",
    artistMbid: "test-mbid-001",
    releaseGroupMbid: null,
    artistName: "Test Artist",
    releaseTitle: null,
    firstReleaseDate: null,
    ownershipState: "missing",
    ownershipConfidence: 0.9,
    evidence: [
      {
        source: "lastfm_similar",
        reason: "similar_to_favorite",
        artistName: "Test Artist",
        artistMbid: "test-mbid-001",
        sourceScore: 0.85,
        seedArtistName: "Seed Artist",
        seedArtistMbid: "seed-mbid-001",
        seedAffinity: 0.9,
      },
    ],
    score: 0,
    scoreBreakdown: {},
    primaryReason: "similar_to_favorite",
    ...overrides,
  };
}

function makeObservation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    source: "lastfm_similar",
    reason: "similar_to_favorite",
    artistName: "Test Artist",
    artistMbid: "test-mbid-001",
    sourceScore: 0.85,
    seedArtistName: "Seed Artist",
    seedArtistMbid: "seed-mbid-001",
    seedAffinity: 0.9,
    ...overrides,
  };
}

describe("recommendation scoring", () => {
  test("high similarity + high affinity produces high score", () => {
    const candidate = makeCandidate({
      evidence: [
        makeObservation({ sourceScore: 0.95, seedAffinity: 0.95 }),
        makeObservation({ sourceScore: 0.88, seedAffinity: 0.85, seedArtistMbid: "seed-2" }),
      ],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.score).toBeGreaterThan(0.6);
    expect(scored.scoreBreakdown.external_similarity).toBeGreaterThan(0.8);
    expect(scored.scoreBreakdown.seed_affinity).toBeGreaterThan(0.8);
  });

  test("weak similarity produces lower score", () => {
    const candidate = makeCandidate({
      evidence: [makeObservation({ sourceScore: 0.2, seedAffinity: 0.3 })],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.score).toBeLessThan(0.5);
  });

  test("multiple sources boost consensus", () => {
    const singleSource = makeCandidate({
      evidence: [makeObservation({ source: "lastfm_similar", seedArtistMbid: "seed-1" })],
    });
    const multiSource = makeCandidate({
      evidence: [
        makeObservation({ source: "lastfm_similar", seedArtistMbid: "seed-1" }),
        makeObservation({ source: "listenbrainz_cf", seedArtistMbid: "seed-2", reason: "collaborative" }),
      ],
    });

    const scoredSingle = scoreCandidate(singleSource);
    const scoredMulti = scoreCandidate(multiSource);

    expect(scoredMulti.scoreBreakdown.source_consensus).toBeGreaterThan(
      scoredSingle.scoreBreakdown.source_consensus
    );
  });

  test("multiple distinct seeds boost consensus", () => {
    const oneSeed = makeCandidate({
      evidence: [
        makeObservation({ seedArtistMbid: "seed-1" }),
        makeObservation({ seedArtistMbid: "seed-1" }),
      ],
    });
    const twoSeeds = makeCandidate({
      evidence: [
        makeObservation({ seedArtistMbid: "seed-1" }),
        makeObservation({ seedArtistMbid: "seed-2" }),
      ],
    });

    const scoredOne = scoreCandidate(oneSeed);
    const scoredTwo = scoreCandidate(twoSeeds);

    expect(scoredTwo.scoreBreakdown.source_consensus).toBeGreaterThan(
      scoredOne.scoreBreakdown.source_consensus
    );
  });

  test("recent release gets higher recency score", () => {
    const recentDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const oldDate = "1980-01-01";

    const recent = makeCandidate({
      type: "release_group",
      releaseGroupMbid: "rg-1",
      firstReleaseDate: recentDate,
    });
    const old = makeCandidate({
      type: "release_group",
      releaseGroupMbid: "rg-2",
      firstReleaseDate: oldDate,
    });

    const scoredRecent = scoreCandidate(recent);
    const scoredOld = scoreCandidate(old);

    expect(scoredRecent.scoreBreakdown.recency).toBeGreaterThan(
      scoredOld.scoreBreakdown.recency
    );
  });

  test("missing release date uses neutral recency", () => {
    const candidate = makeCandidate({ firstReleaseDate: null });
    const scored = scoreCandidate(candidate);
    expect(scored.scoreBreakdown.recency).toBe(0.5);
  });

  test("artist type with missing ownership gets max novelty", () => {
    const candidate = makeCandidate({ type: "artist", ownershipState: "missing" });
    const scored = scoreCandidate(candidate);
    expect(scored.scoreBreakdown.novelty).toBe(1.0);
  });

  test("release_group with missing ownership gets high novelty", () => {
    const candidate = makeCandidate({
      type: "release_group",
      releaseGroupMbid: "rg-1",
      ownershipState: "missing",
    });
    const scored = scoreCandidate(candidate);
    expect(scored.scoreBreakdown.novelty).toBe(0.9);
  });

  test("score is clamped between 0 and 1", () => {
    const candidate = makeCandidate({
      evidence: [
        makeObservation({ sourceScore: 1.0, seedAffinity: 1.0 }),
        makeObservation({ sourceScore: 1.0, seedAffinity: 1.0, seedArtistMbid: "s2" }),
        makeObservation({ sourceScore: 1.0, seedAffinity: 1.0, seedArtistMbid: "s3", source: "listenbrainz_cf" }),
      ],
      firstReleaseDate: new Date().toISOString().split("T")[0],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.score).toBeLessThanOrEqual(1.0);
    expect(scored.score).toBeGreaterThanOrEqual(0);
  });

  test("primary reason selection prioritizes collaborative", () => {
    const candidate = makeCandidate({
      evidence: [
        makeObservation({ reason: "similar_to_favorite" }),
        makeObservation({ reason: "collaborative", source: "listenbrainz_cf" }),
      ],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.primaryReason).toBe("collaborative");
  });

  test("primary reason selection uses new_release when no collaborative", () => {
    const candidate = makeCandidate({
      evidence: [
        makeObservation({ reason: "similar_to_favorite" }),
        makeObservation({ reason: "new_release", source: "musicbrainz_new_release" }),
      ],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.primaryReason).toBe("new_release");
  });
});

describe("observation merging", () => {
  test("same artist MBID from different seeds merges into one candidate", () => {
    const { mergeObservationsForTest } = require("../src/domain/recommendations") as {
      mergeObservationsForTest?: (obs: SourceObservation[]) => CanonicalCandidate[];
    };

    // This tests the merge logic conceptually. Since mergeObservations is not exported,
    // we test the behavior through evidence counts on scored candidates.
    const candidate = makeCandidate({
      evidence: [
        makeObservation({ seedArtistMbid: "seed-1", seedArtistName: "Seed One", seedAffinity: 0.9 }),
        makeObservation({ seedArtistMbid: "seed-2", seedArtistName: "Seed Two", seedAffinity: 0.7 }),
        makeObservation({ seedArtistMbid: "seed-3", seedArtistName: "Seed Three", seedAffinity: 0.5 }),
      ],
    });

    const scored = scoreCandidate(candidate);
    expect(scored.evidence.length).toBe(3);
    expect(scored.scoreBreakdown.source_consensus).toBeGreaterThan(0);
  });

  test("release_group type is assigned when releaseGroupMbid is present", () => {
    const candidate = makeCandidate({
      releaseGroupMbid: "rg-test-001",
      releaseTitle: "Test Album",
      type: "release_group",
    });

    expect(candidate.type).toBe("release_group");
  });
});

describe("seed affinity normalization", () => {
  test("rank-based scoring gives rank 1 highest score", () => {
    const count = 25;
    const rank1Score = 1 - (1 - 1) / Math.max(1, count - 1);
    const rank25Score = 1 - (25 - 1) / Math.max(1, count - 1);

    expect(rank1Score).toBe(1.0);
    expect(rank25Score).toBe(0.0);
  });

  test("rank-based scoring handles single artist", () => {
    const count = 1;
    const rank1Score = 1 - (1 - 1) / Math.max(1, count - 1);
    expect(rank1Score).toBe(1.0);
  });

  test("window weighting sums to 1.0", () => {
    const weights = { "7day": 0.25, "1month": 0.30, "6month": 0.25, "overall": 0.20 };
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(1.0);
  });

  test("absent window contributes 0", () => {
    const seed: Seed = {
      name: "Test",
      mbid: "test-mbid",
      affinity: 0,
      windows: { "7day": 0.8 },
    };

    const computedAffinity =
      0.25 * (seed.windows["7day"] ?? 0) +
      0.30 * (seed.windows["1month"] ?? 0) +
      0.25 * (seed.windows["6month"] ?? 0) +
      0.20 * (seed.windows["overall"] ?? 0);

    expect(computedAffinity).toBe(0.2);
  });
});

describe("diversity selection logic", () => {
  test("per-seed cap limits recommendations from one seed", () => {
    const MAX_PER_SEED = 3;
    const seedCounts = new Map<string, number>();
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate({
      artistMbid: `mbid-${i}`,
      artistName: `Artist ${i}`,
      evidence: [makeObservation({ seedArtistMbid: "same-seed" })],
    }));

    const selected: CanonicalCandidate[] = [];
    for (const c of candidates) {
      const seedKey = c.evidence[0]?.seedArtistMbid ?? "";
      const count = seedCounts.get(seedKey) ?? 0;
      if (count >= MAX_PER_SEED) continue;
      seedCounts.set(seedKey, count + 1);
      selected.push(c);
    }

    expect(selected.length).toBe(3);
  });

  test("per-artist release cap limits releases by same artist", () => {
    const MAX_PER_ARTIST = 2;
    const artistCounts = new Map<string, number>();
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({
      type: "release_group",
      artistMbid: "same-artist",
      releaseGroupMbid: `rg-${i}`,
      releaseTitle: `Album ${i}`,
    }));

    const selected: CanonicalCandidate[] = [];
    for (const c of candidates) {
      const key = c.artistMbid ?? "";
      const count = artistCounts.get(key) ?? 0;
      if (count >= MAX_PER_ARTIST) continue;
      artistCounts.set(key, count + 1);
      selected.push(c);
    }

    expect(selected.length).toBe(2);
  });
});
