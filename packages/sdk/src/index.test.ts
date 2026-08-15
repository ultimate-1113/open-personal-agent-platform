/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegatedClient, createPublicClient } from "./index.js";

describe("delegated SDK", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("adds the current bearer token and parses a typed response", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      return Response.json({ mode: "search", results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createDelegatedClient({ baseUrl: "https://example.test",
      getAccessToken: async () => "token" }).query({ sourceId: "source:test", query: "test",
        mode: "search", maxSources: 5 });
    expect(result.mode).toBe("search");
  });

  it("does not add authorization for the public client", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ capabilities: [] });
    }));
    await expect(createPublicClient({ baseUrl: "https://example.test" }).capabilities())
      .resolves.toEqual({ capabilities: [] });
  });

  it.each([
    [Response.json({ title: "SOURCE_NOT_FOUND", requestId: "request:1" }, { status: 404 }), "SOURCE_NOT_FOUND"],
    [new Response("not-json", { status: 503 }), "HTTP_503"],
  ])("raises typed problem details", async (response, title) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const promise = createPublicClient({ baseUrl: "https://example.test" }).capabilities();
    await expect(promise).rejects.toMatchObject({ status: response.status,
      problem: expect.objectContaining({ title }) });
  });
});
