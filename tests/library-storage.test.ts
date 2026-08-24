import { describe, expect, test } from "bun:test";
import { formatLibraryDiskUsage } from "../src/services/library-storage";

describe("formatLibraryDiskUsage", () => {
  test("formats sub-terabyte sizes in GB", () => {
    const result = formatLibraryDiskUsage(500 * 1024 ** 3);
    expect(result.bytes).toBe(500 * 1024 ** 3);
    expect(result.gb).toBe(500);
    expect(result.display).toBe("500 GB");
  });

  test("formats terabyte sizes in TB", () => {
    const bytes = Math.round(1.23 * 1024 ** 4);
    const result = formatLibraryDiskUsage(bytes);
    expect(result.tb).toBe(1.23);
    expect(result.display).toBe("1.23 TB");
  });
});
