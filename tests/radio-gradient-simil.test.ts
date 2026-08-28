import { afterEach, describe, expect, test } from "bun:test";
import { gradientRecording } from "../src/services/radio-gradient-recording-path";
import { parseGradientSimilSearchJson } from "../src/services/radio-gradient-simil";

const originalMin = process.env.GRADIENT_SIMIL_MIN_COSINE;

afterEach(() => {
  if (originalMin == null) delete process.env.GRADIENT_SIMIL_MIN_COSINE;
  else process.env.GRADIENT_SIMIL_MIN_COSINE = originalMin;
});

describe("Gradient simil integration", () => {
  test("uses raw cosine rather than result-set-normalized score", () => {
    process.env.GRADIENT_SIMIL_MIN_COSINE = "0.2";
    const source = gradientRecording("A", "Start");
    const rows = parseGradientSimilSearchJson(JSON.stringify([
      { rank: 1, score: 1, raw_score: 0.41, artist: "B", title: "Bridge", path: "/music/b.flac" },
      { rank: 2, score: 0.02, raw_score: 0.82, artist: "C", title: "Actually closer", path: "/music/c.flac" },
    ]), source, 10);
    expect(rows.map((row) => [row.artist, row.similarity])).toEqual([
      ["B", 0.41],
      ["C", 0.82],
    ]);
    expect(rows.every((row) => row.provider === "local_effnet" && row.confidence === 0.96)).toBe(true);
  });

  test("filters the source recording, duplicates, malformed rows and weak cosine", () => {
    process.env.GRADIENT_SIMIL_MIN_COSINE = "0.3";
    const source = gradientRecording("A", "Start");
    const rows = parseGradientSimilSearchJson(JSON.stringify([
      { raw_score: 0.99, artist: "A", title: "Start" },
      { raw_score: 0.29, artist: "Weak", title: "No" },
      { raw_score: 0.7, artist: "B", title: "Bridge" },
      { raw_score: 0.65, artist: "B", title: "Bridge" },
      { raw_score: "0.9", artist: "Malformed", title: "No" },
      { raw_score: 0.6, artist: "C", title: "Next" },
    ]), source, 2);
    expect(rows.map((row) => `${row.artist} — ${row.title}`)).toEqual(["B — Bridge", "C — Next"]);
  });

  test("malformed JSON degrades to no local embedding evidence", () => {
    expect(parseGradientSimilSearchJson("not-json", gradientRecording("A", "Start"), 10)).toEqual([]);
  });
});
