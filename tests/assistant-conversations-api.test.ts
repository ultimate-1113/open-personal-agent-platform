import { describe, expect, it } from "vitest";
import { createAssistantApp } from "../apps/assistant-worker/src/index.js";

describe("owner conversation registry API", () => {
  it("returns only active conversations for the verified owner", async () => {
    const app = createAssistantApp({
      authorizeOwner: () => Promise.resolve({
        outcome: "authorized" as const,
        principalId: "principal:owner",
      }),
    });
    const response = await app.request("/v1/conversations", {}, {
      DEPLOYMENT_ID: "deployment:test",
      CONTROL: {
        fetch: () => Promise.resolve(Response.json({ conversations: [
          { conversationId: `conversation:${"a".repeat(64)}`, principalId: "principal:owner",
            deletedAt: null, lastUsedAt: "2026-08-25T01:00:00.000Z" },
          { conversationId: `conversation:${"b".repeat(64)}`, principalId: "principal:other",
            deletedAt: null, lastUsedAt: "2026-08-25T00:00:00.000Z" },
          { conversationId: `conversation:${"c".repeat(64)}`, principalId: "principal:owner",
            deletedAt: "2026-08-25T02:00:00.000Z", lastUsedAt: "2026-08-25T02:00:00.000Z" },
        ] })),
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [{
      conversationId: `conversation:${"a".repeat(64)}`,
      deletedAt: null,
      lastUsedAt: "2026-08-25T01:00:00.000Z",
    }] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
