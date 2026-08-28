import { normalizeForComparison } from "../domain/normalization";

/**
 * Split common joined-credit spellings used by Last.fm/MusicBrainz into the
 * individual artist names providers may expose separately.
 */
export function splitRadioArtistCredit(value: string) {
  const parts = value
    .split(/\s+(?:feat(?:uring)?\.?|ft\.?|with)\s+|\s*[;,]\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [value.trim()].filter(Boolean);
}

export function primaryRadioArtistCredit(value: string) {
  return splitRadioArtistCredit(value)[0] ?? value.trim();
}

export function radioArtistCreditMatches(source: string, candidate: string) {
  const sourceFull = normalizeForComparison(source);
  const candidateFull = normalizeForComparison(candidate);
  if (sourceFull === candidateFull) return true;

  const sourceParts = splitRadioArtistCredit(source).map(normalizeForComparison).filter(Boolean);
  const candidateParts = splitRadioArtistCredit(candidate).map(normalizeForComparison).filter(Boolean);
  if (!sourceParts.length || !candidateParts.length) return false;

  if (sourceParts.every((part) => candidateParts.includes(part))) return true;
  return sourceParts[0] === candidateParts[0];
}
