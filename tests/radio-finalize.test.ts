import { describe, expect, test } from "bun:test";
import { summarizeRadioAvailability } from "../src/services/radio-finalize";

describe("Radio finalization diagnostics", () => {
  test("recomputes availability from the final selected playlist", () => {
    expect(summarizeRadioAvailability([
      { availability: "local" },
      { availability: "local" },
      { availability: "spotify" },
      { availability: "unavailable" },
      { availability: "unknown" },
    ])).toEqual({
      selected_count: 5,
      local_count: 2,
      spotify_count: 1,
      unavailable_count: 1,
      unknown_count: 1,
    });
  });

  test("reports an empty finite generation without inventing availability", () => {
    expect(summarizeRadioAvailability([])).toEqual({
      selected_count: 0,
      local_count: 0,
      spotify_count: 0,
      unavailable_count: 0,
      unknown_count: 0,
    });
  });
});
