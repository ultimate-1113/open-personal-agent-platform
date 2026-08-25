import { describe, expect, it } from "vitest";
import { createAssistantApp } from "../apps/assistant-worker/src/index.js";

const authorizedApp = () => createAssistantApp({
  authorizeOwner: () => Promise.resolve({ outcome: "authorized" as const, principalId: "principal:owner" }),
});

describe("owner preference API", () => {
  it("uses Japanese as the default locale when preferences do not exist", async () => {
    const response = await authorizedApp().request("/v1/settings/preferences", {}, {
      DEPLOYMENT_ID: "deployment:test",
      OWNER_TIME_ZONE: "Asia/Tokyo",
      CONTROL: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timeZone: "Asia/Tokyo", locale: "ja" });
  });

  it("stores a locale change with the deployment time zone and owner audit identity", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const response = await authorizedApp().request("/v1/settings/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "locale:1" },
      body: JSON.stringify({ locale: "en" }),
    }, {
      DEPLOYMENT_ID: "deployment:test",
      OWNER_TIME_ZONE: "Asia/Tokyo",
      CONTROL: { fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
        forwarded = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(Response.json({ timeZone: "Asia/Tokyo", locale: "en" }));
      } },
    });

    expect(response.status).toBe(200);
    expect(forwarded).toMatchObject({ timeZone: "Asia/Tokyo", locale: "en",
      principalId: "principal:owner", idempotencyKey: "locale:1" });
  });
});
