import { describe, test, expect } from "bun:test";
import {
  normalize,
  normalizeForComparison,
  removeLeadingThe,
  similarityScore,
  artistMatch,
  titleMatch,
  extractEditionInfo,
  normalizeFileStem,
} from "../src/domain/normalization";

describe("normalize", () => {
  test("lowercases text", () => {
    expect(normalize("Massive Attack")).toBe("massive attack");
  });

  test("collapses whitespace", () => {
    expect(normalize("Massive   Attack")).toBe("massive attack");
  });

  test("trims whitespace", () => {
    expect(normalize("  Massive Attack  ")).toBe("massive attack");
  });

  test("normalizes unicode dashes to hyphen-minus", () => {
    expect(normalize("Massive\u2013Attack")).toBe("massive-attack");
    expect(normalize("Massive\u2014Attack")).toBe("massive-attack");
  });

  test("normalizes curly apostrophes", () => {
    expect(normalize("don\u2019t")).toBe("don't");
    expect(normalize("don\u2018t")).toBe("don't");
  });

  test("normalizes curly quotes", () => {
    expect(normalize("\u201CHello\u201D")).toBe('"hello"');
  });

  test("performs NFKC normalization", () => {
    // ﬁ ligature -> fi
    expect(normalize("\uFB01nal")).toBe("final");
  });
});

describe("normalizeForComparison", () => {
  test("strips accents", () => {
    expect(normalizeForComparison("Björk")).toBe("bjork");
    expect(normalizeForComparison("Café")).toBe("cafe");
    expect(normalizeForComparison("naïve")).toBe("naive");
  });

  test("normalizes and strips accents combined", () => {
    expect(normalizeForComparison("  Beyoncé  ")).toBe("beyonce");
  });
});

describe("removeLeadingThe", () => {
  test("removes leading 'the'", () => {
    expect(removeLeadingThe("the cranberries")).toBe("cranberries");
    expect(removeLeadingThe("The Beatles")).toBe("Beatles");
  });

  test("does not remove 'the' from middle", () => {
    expect(removeLeadingThe("over the rainbow")).toBe("over the rainbow");
  });
});

describe("similarityScore", () => {
  test("exact match returns 1.0", () => {
    expect(similarityScore("Massive Attack", "Massive Attack")).toBe(1.0);
  });

  test("case-insensitive exact returns 1.0", () => {
    expect(similarityScore("massive attack", "MASSIVE ATTACK")).toBe(1.0);
  });

  test("the-prefix variant returns 0.97", () => {
    expect(similarityScore("The Cranberries", "Cranberries")).toBe(0.97);
  });

  test("dissimilar strings return low score", () => {
    expect(similarityScore("Radiohead", "Portishead")).toBeLessThan(0.8);
  });
});

describe("artistMatch", () => {
  test("exact match", () => {
    const result = artistMatch("Massive Attack", "Massive Attack");
    expect(result.match).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.reason).toBe("artist_exact");
  });

  test("the-prefix match", () => {
    const result = artistMatch("The Cranberries", "Cranberries");
    expect(result.match).toBe(true);
    expect(result.confidence).toBe(0.97);
    expect(result.reason).toBe("artist_the_prefix");
  });

  test("partial match (collaboration)", () => {
    const result = artistMatch("Massive Attack", "Massive Attack feat. Tracey Thorn");
    expect(result.match).toBe(true);
    expect(result.reason).toBe("artist_partial");
  });

  test("no match", () => {
    const result = artistMatch("Radiohead", "Portishead");
    expect(result.match).toBe(false);
  });
});

describe("titleMatch", () => {
  test("exact match", () => {
    const result = titleMatch("Mezzanine", "Mezzanine");
    expect(result.match).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.reason).toBe("title_exact");
  });

  test("edition variant match", () => {
    const result = titleMatch("Mezzanine", "Mezzanine (Deluxe Edition)");
    expect(result.match).toBe(true);
    expect(result.reason).toBe("title_edition_variant");
  });

  test("no match for different titles", () => {
    const result = titleMatch("Mezzanine", "Protection");
    expect(result.match).toBe(false);
  });
});

describe("extractEditionInfo", () => {
  test("extracts deluxe edition", () => {
    const result = extractEditionInfo("Mezzanine (Deluxe Edition)");
    expect(result.baseTitle).toBe("Mezzanine");
    expect(result.edition).toContain("Deluxe");
  });

  test("no edition suffix", () => {
    const result = extractEditionInfo("Mezzanine");
    expect(result.baseTitle).toBe("Mezzanine");
    expect(result.edition).toBeUndefined();
  });

  test("extracts remastered", () => {
    const result = extractEditionInfo("OK Computer [Remastered]");
    expect(result.baseTitle).toBe("OK Computer");
  });
});

describe("normalizeFileStem", () => {
  test("strips extension and normalizes", () => {
    expect(normalizeFileStem("01 - Angel.flac")).toBe("01 - angel");
    expect(normalizeFileStem("01 - Angel.lrc")).toBe("01 - angel");
  });

  test("matching stems compare equal", () => {
    expect(normalizeFileStem("01 - Angel.flac")).toBe(
      normalizeFileStem("01 - Angel.lrc")
    );
  });
});
