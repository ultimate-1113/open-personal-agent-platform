/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-base-to-string */
import { describe, expect, it, vi } from "vitest";
import type { InformationPolicy } from "@opap/contracts";
import {
  AISearchKnowledgeSource,
  FixtureKnowledgeSource,
  GitHubKnowledgeSource,
  GoogleDriveKnowledgeSource,
  KnowledgeSourceError,
  StaticSiteKnowledgeSource,
  parseInformationPolicy,
  toSearchResult,
  truncateUtf8,
} from "./index.js";

const policy: InformationPolicy = {
  subjectPrincipalIds: [],
  visibility: "public",
  sensitivity: "normal",
  trust: "external",
  allowedAudienceIds: ["public"],
  allowedDestinationIds: ["provider:workers-ai"],
  retention: { mode: "none" },
};

const input = {
  sourceId: "source:test",
  query: "agent",
  maxResults: 5,
  authorizedResourceIds: [] as string[],
  informationPolicy: policy,
};

describe("StaticSiteKnowledgeSource", () => {
  it("ranks a validated static index without crawling pages", async () => {
    const fetcher = vi.fn(async () => Response.json({
      apiVersion: "opap.dev/static-index/v1",
      revision: "1",
      generatedAt: "2026-08-15T00:00:00.000Z",
      documents: [
        { id: "one", title: "Agent guide", uri: "https://example.com/agent", text: "Build an agent" },
        { id: "two", title: "Unrelated", uri: "https://example.com/other", text: "Nothing here" },
      ],
    })) as unknown as typeof fetch;
    const source = new StaticSiteKnowledgeSource({
      indexUrl: "https://example.com/.well-known/opap-index.json",
      fetcher,
    });
    const results = await source.search(input);
    expect(results).toHaveLength(1);
    expect(results[0]?.resourceId).toBe("one");
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects redirects", async () => {
    const source = new StaticSiteKnowledgeSource({
      indexUrl: "https://example.com/index.json",
      fetcher: vi.fn(async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
    });
    await expect(source.search(input)).rejects.toMatchObject({ code: "SOURCE_SCOPE_DENIED" });
  });

  it.each([
    ["http://example.com/index.json"], ["https://user@example.com/index.json"],
    ["https://localhost/index.json"], ["https://127.0.0.1/index.json"],
    ["https://10.0.0.1/index.json"], ["https://192.168.1.1/index.json"],
    ["https://172.16.0.1/index.json"], ["https://[::1]/index.json"],
  ])("rejects an unsafe index URL %s", (indexUrl) => {
    expect(() => new StaticSiteKnowledgeSource({ indexUrl })).toThrow(KnowledgeSourceError);
  });

  it.each([
    ["fetch", vi.fn(async () => { throw new Error("network"); }), "SOURCE_UNAVAILABLE"],
    ["http", vi.fn(async () => new Response(null, { status: 503 })), "SOURCE_UNAVAILABLE"],
    ["length", vi.fn(async () => new Response("{}", { headers: { "Content-Length": "1048577" } })), "SOURCE_RESULT_INVALID"],
    ["schema", vi.fn(async () => Response.json({ apiVersion: "wrong" })), "SOURCE_RESULT_INVALID"],
    ["json", vi.fn(async () => new Response("{")), "SOURCE_RESULT_INVALID"],
  ])("normalizes %s failures", async (_name, fetcher, code) => {
    const source = new StaticSiteKnowledgeSource({ indexUrl: "https://example.com/index.json",
      fetcher: fetcher as unknown as typeof fetch });
    await expect(source.search(input)).rejects.toMatchObject({ code });
  });
});

describe("AISearchKnowledgeSource", () => {
  it("normalizes public endpoint chunks with the default retrieval policy", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        messages: [{ role: "user", content: "agent" }],
        ai_search_options: { retrieval: { retrieval_type: "keyword", max_num_results: 10,
          match_threshold: 0.4, context_expansion: 0 }, query_rewrite: { enabled: false },
          reranking: { enabled: false } },
      });
      return Response.json({ chunks: [{
        id: "doc:1", title: "OPAP", url: "https://example.com/opap", text: "Agent platform",
      }] });
    }) as unknown as typeof fetch;
    const source = new AISearchKnowledgeSource({
      kind: "public-endpoint",
      endpoint: "https://search.example.com/search",
      fetcher,
    });
    const chunks = await source.search(input);
    expect(chunks[0]).toMatchObject({ resourceId: "doc:1", title: "OPAP" });
    expect(toSearchResult(chunks[0]!)).toMatchObject({ sourceId: "source:test" });
  });

  it("applies a source-specific vector retrieval policy", async () => {
    const search = vi.fn(async () => ({ chunks: [{ id: "bound", title: "Bound",
      url: "https://example.com/bound", text: "agent" }] }));
    const source = new AISearchKnowledgeSource({ kind: "workers-binding", binding: { search } }, {
      retrievalType: "vector", candidateResults: 10, matchThreshold: 0.4,
      contextExpansion: 1, answerContextCharacters: 4_000, answerMaxOutputTokens: 4_096,
      answerReasoningEffort: "low",
    });
    await source.search({ ...input, maxResults: 5 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ ai_search_options: {
      retrieval: { retrieval_type: "vector", max_num_results: 10,
        match_threshold: 0.4, context_expansion: 1 },
      query_rewrite: { enabled: false }, reranking: { enabled: false },
    } }));
  });

  it("uses the Workers binding transport", async () => {
    const search = vi.fn(async () => ({ chunks: [{
      id: "bound", title: "Bound", url: "https://example.com/bound", text: "agent",
    }] }));
    const source = new AISearchKnowledgeSource({ kind: "workers-binding", binding: { search } });
    expect(await source.search(input)).toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
  });

  it("normalizes the actual nested AI Search response", async () => {
    const source = new AISearchKnowledgeSource({ kind: "workers-binding", binding: { search: async () => ({
      success: true, result: { chunks: [{ id: 7, text: "agent", item: {
        key: "https://example.com/docs/agent.md", timestamp: 1_786_273_800_000,
        metadata: { title: "Agent metadata" },
      } }] },
    }) } });
    const result = await source.search(input);
    expect(result[0]).toMatchObject({ resourceId: "7", title: "agent.md",
      uri: "https://example.com/docs/agent.md", observedAt: new Date(1_786_273_800_000).toISOString() });
  });

  it.each([
    ["http", vi.fn(async () => new Response(null, { status: 500 })), "SOURCE_UNAVAILABLE"],
    ["invalid", vi.fn(async () => Response.json({ nope: true })), "SOURCE_RESULT_INVALID"],
    ["invalid JSON", vi.fn(async () => new Response("{")), "SOURCE_RESULT_INVALID"],
    ["oversize", vi.fn(async () => new Response("{}", { headers: { "Content-Length": "1048577" } })),
      "SOURCE_RESULT_INVALID"],
    ["missing uri", vi.fn(async () => Response.json({ chunks: [{ text: "agent" }] })), "SOURCE_RESULT_INVALID"],
  ])("normalizes endpoint %s failures", async (_name, fetcher, code) => {
    const source = new AISearchKnowledgeSource({ kind: "public-endpoint",
      endpoint: "https://example.com/search", fetcher: fetcher as unknown as typeof fetch });
    await expect(source.search(input)).rejects.toMatchObject({ code });
  });

  it("rejects invalid endpoints", () => {
    expect(() => new AISearchKnowledgeSource({
      kind: "public-endpoint", endpoint: "http://127.0.0.1/search",
    })).toThrow(KnowledgeSourceError);
  });
});

describe("fixture and helpers", () => {
  it("returns deterministic fixture metadata and safely truncates UTF-8", async () => {
    expect(truncateUtf8("abc", 5)).toBe("abc");
    expect(new TextEncoder().encode(truncateUtf8("日本語", 4)).byteLength).toBeLessThanOrEqual(4);
    expect(await new FixtureKnowledgeSource().search(input)).toHaveLength(1);
    expect(parseInformationPolicy(policy)).toEqual(policy);
    expect(() => parseInformationPolicy({ visibility: "secret" })).toThrow(KnowledgeSourceError);
  });
});

describe("delegated source adapters", () => {
  it("searches an allowlisted Drive folder and file", async () => {
    const reader = { read: vi.fn(async (request: { resourceId: string; operation: string }) => {
      if (request.operation === "file.get") return request.resourceId === "folder"
        ? { mimeType: "application/vnd.google-apps.folder" } : { mimeType: "text/plain" };
      if (request.operation === "folder.search") return { files: [null,
        { id: "child", name: "Agent doc", webViewLink: "https://drive.example/child",
          description: "agent policy", modifiedTime: "2026-08-15T00:00:00Z" },
        { id: "invalid" }] };
      return { title: "Agent file", content: "agent content", modifiedTime: "invalid" };
    }) };
    const source = new GoogleDriveKnowledgeSource("connection:drive", reader);
    const result = await source.search({ ...input, authorizedResourceIds: ["folder", "file"] });
    expect(result.map((chunk) => chunk.resourceId)).toEqual(["child", "file"]);
    expect(result[1]?.uri).toContain("drive.google.com/open");
  });

  it("rejects invalid Drive results and skips non-matches", async () => {
    const invalid = new GoogleDriveKnowledgeSource("connection:drive", { read: async () => null });
    await expect(invalid.search({ ...input, authorizedResourceIds: ["file"] }))
      .rejects.toMatchObject({ code: "SOURCE_RESULT_INVALID" });
    const noMatch = new GoogleDriveKnowledgeSource("connection:drive", { read: async (request) =>
      request.operation === "file.get" ? { mimeType: "text/plain" } : { title: "No", content: "other" } });
    expect(await noMatch.search({ ...input, authorizedResourceIds: ["file"] })).toEqual([]);
  });

  it("normalizes GitHub code, issue and pull request search results", async () => {
    const source = new GitHubKnowledgeSource("connection:github", { read: async () => ({
      code: { items: [null, { path: "src/index.ts", html_url: "https://github.com/o/r/blob/main/src/index.ts",
        text_matches: [{ fragment: "agent code" }, { fragment: 2 }] }, { path: "invalid" }] },
      issues: { items: [{ number: 1, title: "Agent issue", body: "agent body",
        html_url: "https://github.com/o/r/issues/1", updated_at: "2026-08-15T00:00:00Z" },
        { number: 2, title: "PR", html_url: "https://github.com/o/r/pull/2", updated_at: "invalid" },
        { title: "invalid" }] },
    }) });
    const result = await source.search({ ...input, authorizedResourceIds: ["o/r"], maxResults: 5 });
    expect(result.map((chunk) => chunk.resourceId)).toEqual(["o/r:src/index.ts", "o/r#1", "o/r#2"]);
  });

  it("rejects invalid GitHub results", async () => {
    const source = new GitHubKnowledgeSource("connection:github", { read: async () => null });
    await expect(source.search({ ...input, authorizedResourceIds: ["o/r"] }))
      .rejects.toMatchObject({ code: "SOURCE_RESULT_INVALID" });
  });
});
