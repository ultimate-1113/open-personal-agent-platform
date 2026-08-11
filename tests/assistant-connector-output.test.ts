import { describe, expect, it } from "vitest";
import { formatConnectorResult } from "../apps/assistant-worker/src/index.js";

describe("assistant connector output", () => {
  it("formats Calendar data as a readable list instead of exposing JSON", () => {
    const result = formatConnectorResult(`Calendar result:\n${JSON.stringify({
      items: [{ summary: "Project meeting", start: { dateTime: "2026-08-12T10:00:00+09:00" } }],
    })}`);
    expect(result).toContain("- Project meeting (2026-08-12T10:00:00+09:00)");
    expect(result).not.toContain('"items"');
  });

  it("formats repositories and empty results without raw JSON", () => {
    expect(formatConnectorResult(`GitHub result:\n${JSON.stringify([
      { full_name: "ultimate-1113/open-personal-agent-platform", html_url: "https://github.com/example/repo" },
    ])}`)).toContain("- ultimate-1113/open-personal-agent-platform");
    expect(formatConnectorResult("GitHub result:\n[]")).toContain("該当する項目はありません");
  });
});
