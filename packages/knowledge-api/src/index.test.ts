/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { boundQueryResponse, handleMcp } from "./index.js";

const request = (method: string, params?: unknown) => new Request("https://example.test/mcp", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

describe("stateless Streamable HTTP MCP", () => {
  const service = {
    listSources: async () => [{ sourceId: "source:test", kind: "fixture" }],
    query: async (input: { mode: "search" | "answer" }) => input.mode === "search"
      ? { mode: "search" as const, results: [] }
      : { mode: "answer" as const, answer: "answer", citations: [],
        observationId: `observation:${"a".repeat(64)}`, model: { providerId: "provider:test" } },
  };
  it("advertises exactly the three knowledge tools", async () => {
    const response = await handleMcp(request("tools/list"), service);
    const value = await response.json() as { result: { tools: { name: string }[] } };
    expect(value.result.tools.map((tool) => tool.name)).toEqual([
      "list_knowledge_sources", "search_knowledge", "answer_knowledge",
    ]);
  });
  it("calls the shared query service", async () => {
    const response = await handleMcp(request("tools/call", { name: "search_knowledge",
      arguments: { sourceId: "source:test", query: "test", maxSources: 5 } }), service);
    const value = await response.json() as { result: { structuredContent: { mode: string } } };
    expect(value.result.structuredContent.mode).toBe("search");
  });
  it("initializes without server state and accepts the initialized notification", async () => {
    const initialized = await handleMcp(request("initialize"), service);
    expect(await initialized.json()).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
    expect((await handleMcp(request("notifications/initialized"), service)).status).toBe(202);
  });
  it.each([
    [new Request("https://example.test/mcp", { method: "POST", body: "{}" }), 415],
    [new Request("https://example.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[" }), 200],
  ])("rejects malformed transport requests", async (input, status) => {
    expect((await handleMcp(input, service)).status).toBe(status);
  });
  it("returns JSON-RPC errors for unknown methods and tools", async () => {
    expect(await (await handleMcp(request("unknown"), service)).json()).toMatchObject({ error: { code: -32601 } });
    expect(await (await handleMcp(request("tools/call", { name: "unknown" }), service)).json())
      .toMatchObject({ error: { code: -32602 } });
    expect(await (await handleMcp(request("tools/call", { name: "search_knowledge", arguments: {} }), service)).json())
      .toMatchObject({ error: { code: -32602 } });
  });
  it("lists sources and calls answer", async () => {
    expect(await (await handleMcp(request("tools/call", { name: "list_knowledge_sources" }), service)).json())
      .toMatchObject({ result: { content: [{ type: "text" }] } });
    expect(await (await handleMcp(request("tools/call", { name: "answer_knowledge", arguments: {
      sourceId: "source:test", query: "test", maxSources: 5,
    } }), service)).json()).toMatchObject({ result: { structuredContent: { mode: "answer" } } });
  });
  it("returns tool errors as MCP results instead of transport failures", async () => {
    const response = await handleMcp(request("tools/call", { name: "search_knowledge", arguments: {
      sourceId: "source:test", query: "test",
    } }), { ...service, query: async () => { throw new Error("SOURCE_UNAVAILABLE"); } });
    expect(await response.json()).toMatchObject({ result: { isError: true,
      content: [{ text: "SOURCE_UNAVAILABLE" }] } });
  });
  it("bounds search responses to 64 KiB", () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      sourceId: "source:test", resourceId: `resource:${index}`, title: "x".repeat(2_000),
      uri: `https://example.test/${index}`, excerpt: "x".repeat(2_048),
      observedAt: "2026-08-15T00:00:00.000Z", observationId: `observation:${index}`,
    }));
    const bounded = boundQueryResponse({ mode: "search", results });
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(65_536);
    expect(bounded.mode === "search" && bounded.results.length).toBeLessThan(20);
  });
});
