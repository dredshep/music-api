import { describe, expect, test } from "bun:test";
import { assessAcousticTransition } from "../src/services/radio-transition-quality";

describe("Radio acoustic transition quality", () => {
  test("catastrophic multi-dimensional cliffs are vetoed", () => {
    const assessment = assessAcousticTransition({
      bpm: 190,
      energy: 0.95,
      loudness: -4,
      timbre: {
        spectral_centroid_mean: 6500,
        spectral_centroid_std: 3000,
        zero_crossing_rate_mean: 0.3,
      },
      outro: { dbfs: -3 },
    }, {
      bpm: 82,
      energy: 0.08,
      loudness: -27,
      timbre: {
        spectral_centroid_mean: 600,
        spectral_centroid_std: 300,
        zero_crossing_rate_mean: 0.02,
      },
      intro: { dbfs: -27 },
    });
    expect(assessment.evidenceCount).toBeGreaterThanOrEqual(4);
    expect(assessment.catastrophic).toBe(true);
    expect(assessment.reasons.length).toBeGreaterThan(0);
  });

  test("a substantial but progressive change is not automatically vetoed", () => {
    const assessment = assessAcousticTransition({
      bpm: 145,
      energy: 0.72,
      loudness: -8,
      timbre: {
        spectral_centroid_mean: 3200,
        spectral_centroid_std: 1500,
        zero_crossing_rate_mean: 0.14,
      },
      outro: { dbfs: -9 },
    }, {
      bpm: 162,
      energy: 0.88,
      loudness: -6,
      timbre: {
        spectral_centroid_mean: 4100,
        spectral_centroid_std: 1900,
        zero_crossing_rate_mean: 0.19,
      },
      intro: { dbfs: -7 },
    });
    expect(assessment.evidenceCount).toBeGreaterThanOrEqual(4);
    expect(assessment.catastrophic).toBe(false);
  });

  test("missing analysis is unknown rather than perfect compatibility", () => {
    const assessment = assessAcousticTransition(null, {
      bpm: 120,
      energy: 0.5,
    });
    expect(assessment.evidenceCount).toBe(0);
    expect(assessment.score).toBeNull();
    expect(assessment.catastrophic).toBe(false);
  });
});
