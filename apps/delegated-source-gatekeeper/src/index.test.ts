import { describe, expect, it } from "vitest";
import { githubIssueFallbackItems, githubTreeFallbackItems } from "./index.js";

describe("delegated GitHub search fallbacks", () => {
  it("returns only matching blob paths from the already-authorized repository", () => {
    const results = githubTreeFallbackItems({
      query: "Phase 4 knowledge",
      resourceId: "ultimate-1113/open-personal-agent-platform",
      defaultBranch: "main",
      maximum: 2,
      tree: [
        { type: "blob", path: "docs/ja/operations/phase-4-knowledge.md" },
        { type: "tree", path: "docs/ja/operations" },
        { type: "blob", path: "README.md" },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.["path"]).toBe("docs/ja/operations/phase-4-knowledge.md");
    expect(results[0]?.["html_url"]).toBe(
      "https://github.com/ultimate-1113/open-personal-agent-platform/blob/main/docs/ja/operations/phase-4-knowledge.md",
    );
  });

  it("matches issue title or body and respects the requested maximum", () => {
    const results = githubIssueFallbackItems("delegated search", [
      { number: 1, title: "Unrelated", body: "delegated source search fails" },
      { number: 2, title: "Delegated search", body: "second" },
      { number: 3, title: "Delegated search", body: "third" },
      null,
    ], 2);

    expect(results.map((item) => item["number"])).toEqual([1, 2]);
  });

  it("does not return arbitrary paths for an empty or nonmatching query", () => {
    expect(githubTreeFallbackItems({
      query: "missing-term",
      resourceId: "ultimate-1113/open-personal-agent-platform",
      defaultBranch: "main",
      maximum: 20,
      tree: [{ type: "blob", path: "README.md" }],
    })).toEqual([]);
  });
});
