/**
 * Text normalization for music metadata comparison.
 * Preserves original values for display; returns normalized forms for matching.
 */

const DASH_VARIANTS = /[\u2010\u2011\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]/g;
const APOSTROPHE_VARIANTS = /[\u2018\u2019\u201A\u201B\u2032\u0060\uFF07]/g;
const QUOTE_VARIANTS = /[\u201C\u201D\u201E\u201F\u2033\uFF02]/g;
const WHITESPACE_COLLAPSE = /\s+/g;

export function normalize(input: string): string {
  let s = input;

  // Unicode NFKC normalization
  s = s.normalize("NFKC");

  // Lowercase
  s = s.toLowerCase();

  // Normalize dashes to hyphen-minus
  s = s.replace(DASH_VARIANTS, "-");

  // Normalize apostrophes
  s = s.replace(APOSTROPHE_VARIANTS, "'");

  // Normalize quotes
  s = s.replace(QUOTE_VARIANTS, '"');

  // Collapse whitespace
  s = s.replace(WHITESPACE_COLLAPSE, " ");

  // Trim
  s = s.trim();

  return s;
}

export function normalizeForComparison(input: string): string {
  let s = normalize(input);

  // Remove accents for comparison (NFKD + strip combining marks)
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  return s;
}

export function removeLeadingThe(input: string): string {
  return input.replace(/^the\s+/i, "");
}

export function similarityScore(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);

  if (na === nb) return 1.0;

  // Try without leading "the"
  const naNoThe = removeLeadingThe(na);
  const nbNoThe = removeLeadingThe(nb);
  if (naNoThe === nbNoThe) return 0.97;

  // Levenshtein-based similarity for close matches
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(na, nb);
  const similarity = 1 - dist / maxLen;

  return similarity;
}

export function artistMatch(
  queryArtist: string,
  libraryArtist: string
): { match: boolean; confidence: number; reason: string } {
  const nq = normalizeForComparison(queryArtist);
  const nl = normalizeForComparison(libraryArtist);

  if (nq === nl) {
    return { match: true, confidence: 1.0, reason: "artist_exact" };
  }

  // Without leading "the"
  if (removeLeadingThe(nq) === removeLeadingThe(nl)) {
    return { match: true, confidence: 0.97, reason: "artist_the_prefix" };
  }

  // Check if one contains the other (collaboration credits)
  if (nl.includes(nq) || nq.includes(nl)) {
    return { match: true, confidence: 0.85, reason: "artist_partial" };
  }

  // Levenshtein similarity
  const sim = similarityScore(queryArtist, libraryArtist);
  if (sim >= 0.9) {
    return { match: true, confidence: sim, reason: "artist_fuzzy" };
  }

  return { match: false, confidence: sim, reason: "artist_no_match" };
}

export function titleMatch(
  queryTitle: string,
  libraryTitle: string
): { match: boolean; confidence: number; reason: string } {
  const nq = normalizeForComparison(queryTitle);
  const nl = normalizeForComparison(libraryTitle);

  if (nq === nl) {
    return { match: true, confidence: 1.0, reason: "title_exact" };
  }

  // Strip common edition suffixes for base comparison
  const nqBase = stripEditionSuffix(nq);
  const nlBase = stripEditionSuffix(nl);

  if (nqBase === nlBase) {
    return { match: true, confidence: 0.93, reason: "title_edition_variant" };
  }

  // Fuzzy similarity
  const sim = similarityScore(queryTitle, libraryTitle);
  if (sim >= 0.85) {
    return { match: true, confidence: sim, reason: "title_fuzzy" };
  }

  return { match: false, confidence: sim, reason: "title_no_match" };
}

const EDITION_SUFFIXES =
  /\s*[\(\[]\s*(deluxe|expanded|anniversary|remaster(ed)?|bonus\s*track|special|limited|japan(ese)?|uk|us)\s*(edition|version|remaster)?\s*[\)\]]\s*$/i;

function stripEditionSuffix(s: string): string {
  return s.replace(EDITION_SUFFIXES, "").trim();
}

export function extractEditionInfo(title: string): {
  baseTitle: string;
  edition?: string;
} {
  const match = title.match(EDITION_SUFFIXES);
  if (match) {
    return {
      baseTitle: title.replace(EDITION_SUFFIXES, "").trim(),
      edition: match[0]?.trim().replace(/^[\(\[]|[\)\]]$/g, ""),
    };
  }
  return { baseTitle: title };
}

export function normalizeFileStem(filename: string): string {
  // Remove extension, normalize for LRC matching
  const stem = filename.replace(/\.[^.]+$/, "");
  return normalize(stem);
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0)
  );

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }

  return dp[m]![n]!;
}
