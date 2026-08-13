import { describe, expect, it } from "vitest";

import { didInsertDedupeKey, discordResponseFlags } from "./index.js";

describe("Discord deduplication", () => {
  it("accepts inserts that also update one or more indexes", () => {
    expect(didInsertDedupeKey(0)).toBe(false);
    expect(didInsertDedupeKey(1)).toBe(true);
    expect(didInsertDedupeKey(2)).toBe(true);
    expect(didInsertDedupeKey(3)).toBe(true);
  });

  it("keeps guild responses private without marking direct messages ephemeral", () => {
    expect(discordResponseFlags("guild:1")).toEqual({ flags: 64 });
    expect(discordResponseFlags()).toEqual({});
  });
});
