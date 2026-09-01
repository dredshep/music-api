import { describe, expect, test } from "bun:test";
import { normalizeRadioSettingsPatch, parseRadioSettings } from "../src/db/repositories/radio";

describe("legacy radio settings compatibility", () => {
  test("maps ownedBias to navidromeBias without leaking the legacy key", () => {
    const settings = parseRadioSettings(JSON.stringify({ ownedBias: 0.6 }));
    expect(settings.navidromeBias).toBe(0.6);
    expect("ownedBias" in settings).toBe(false);
  });

  test("prefers an explicit navidromeBias over the legacy alias", () => {
    const patch = normalizeRadioSettingsPatch({ ownedBias: -0.8, navidromeBias: 0.25 });
    expect(patch.navidromeBias).toBe(0.25);
    expect("ownedBias" in patch).toBe(false);
  });
});
