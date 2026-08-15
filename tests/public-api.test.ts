import { describe, expect, it, vi } from "vitest";
import { createPublicApp } from "../apps/public-agent-api/src/index.js";

describe("Public Knowledge API", () => {
  it("serves a cache hit without quota or source access", async () => {
    const quotaGet = vi.fn(() => { throw new Error("quota must not be called"); });
    const sourceFactory = vi.fn(() => { throw new Error("source must not be called"); });
    const cached = Response.json({ mode: "search", results: [] }, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
    const app = createPublicApp({ cache: () => ({
      match: () => Promise.resolve(cached.clone()),
    }) as unknown as Cache, sourceFactory });
    const response = await app.request("/v1/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source:public-fixture", query: "cached", mode: "search" }),
    }, {
      ENVIRONMENT: "test", DEPLOYMENT_ID: "deployment:test",
      PUBLIC_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
      PUBLIC_QUOTA: { idFromName: (name: string) => name, get: quotaGet },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "search", results: [] });
    expect(quotaGet).not.toHaveBeenCalled();
    expect(sourceFactory).not.toHaveBeenCalled();
  });

  it("does not expose owner APIs or list private bindings", async () => {
    const app = createPublicApp();
    const bindings = {
      ENVIRONMENT: "test", DEPLOYMENT_ID: "deployment:test",
      PUBLIC_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
      PUBLIC_QUOTA: { idFromName: (name: string) => name,
        get: () => ({ fetch: () => Promise.resolve(Response.json({ status: "ok" })) }) },
    };
    expect((await app.request("/v1/conversations", {}, bindings)).status).toBe(404);
    const capabilities = await (await app.request("/v1/capabilities", {}, bindings)).json() as {
      capabilities: { sources: { sourceId: string }[] }[];
    };
    expect(capabilities.capabilities[0]?.sources.map((source) => source.sourceId))
      .toEqual(["source:public-fixture"]);
  });
});
