import { describe, expect, it } from "vitest";
import { createAssistantApp } from "../apps/assistant-worker/src/index.js";

describe("assistant health endpoint", () => {
  it("does not disclose authentication or private binding diagnostics", async () => {
    const app = createAssistantApp({
      authorizeOwner: () => Promise.resolve({ outcome: "denied" }),
    });

    const response = await app.request(
      "/health",
      undefined,
      { ENVIRONMENT: "staging" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "assistant-worker",
      status: "ok",
    });
  });
});
