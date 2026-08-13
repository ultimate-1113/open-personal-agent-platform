import { describe, expect, it } from "vitest";

import { requiresApprovedDiscordGuild } from "../apps/assistant-worker/src/index.js";

describe("Discord guild command admission", () => {
  it("allows notify-here to request approval from an unapproved channel", () => {
    expect(requiresApprovedDiscordGuild("notify-here")).toBe(false);
  });

  it.each(["agent", "tasks", "approvals", "audit", "status", "notify-off-here"])(
    "keeps %s behind the approved-channel policy",
    (commandName) => expect(requiresApprovedDiscordGuild(commandName)).toBe(true),
  );
});
