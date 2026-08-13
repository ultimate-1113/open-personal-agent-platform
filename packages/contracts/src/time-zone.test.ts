import { describe, expect, it } from "vitest";

import { normalizeTimeZone } from "./index.js";

describe("normalizeTimeZone", () => {
  it.each([
    ["+9", "+09:00"],
    ["+9:00", "+09:00"],
    ["UTC+9", "+09:00"],
    ["GMT-5:30", "-05:30"],
    ["+00", "UTC"],
    ["utc", "UTC"],
    ["Asia/Tokyo", "Asia/Tokyo"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeTimeZone(input)).toBe(expected);
  });

  it.each(["+24", "+09:60", "UTC+", "not-a-zone", ""])("rejects %s", (input) => {
    expect(normalizeTimeZone(input)).toBeUndefined();
  });
});
