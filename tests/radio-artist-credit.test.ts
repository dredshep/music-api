import { describe, expect, test } from "bun:test";
import {
  primaryRadioArtistCredit,
  radioArtistCreditMatches,
  splitRadioArtistCredit,
} from "../src/services/radio-artist-credit";

describe("radio artist credits", () => {
  test("splits explicit featuring credits", () => {
    expect(splitRadioArtistCredit("Grimes featuring HANA")).toEqual(["Grimes", "HANA"]);
    expect(primaryRadioArtistCredit("Grimes featuring HANA")).toBe("Grimes");
  });

  test("matches joined and provider-separated primary credits", () => {
    expect(radioArtistCreditMatches("Grimes featuring HANA", "Grimes, HANA")).toBe(true);
    expect(radioArtistCreditMatches("Grimes feat. HANA", "Grimes")).toBe(true);
  });
});
