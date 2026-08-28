import { describe, expect, test } from "bun:test";
import { localRadioCandidateMatches } from "../src/services/radio-local-resolution";

describe("Radio local title matching", () => {
  test("accepts harmless trailing punctuation variants", () => {
    expect(localRadioCandidateMatches("Satyricon", "K.I.N.G", "Satyricon", "K.I.N.G.")).toBe(true);
  });

  test("still rejects a different title", () => {
    expect(localRadioCandidateMatches("Satyricon", "K.I.N.G", "Satyricon", "The Pentagram Burns")).toBe(false);
  });
});
