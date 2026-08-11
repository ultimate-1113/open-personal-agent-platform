import { describe, expect, it } from "vitest";
import {
  connectorSummaryMessages,
  continuationIntentPrompt,
  formatConnectorResult,
  githubRepositoryFullNames,
  inferCalendarRange,
  normalConversationContext,
  selectConnectorToolNames,
} from "../apps/assistant-worker/src/index.js";

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

  it("extracts only fully qualified accessible repository names", () => {
    expect(githubRepositoryFullNames({ repositories: [
      { full_name: "ultimate-1113/open-personal-agent-platform" },
      { full_name: "invalid" },
      { name: "missing-owner" },
    ] })).toEqual(["ultimate-1113/open-personal-agent-platform"]);
  });

  it("continues a write request after answering a clarification", () => {
    const history = [
      { role: "user" as const, content: "open-personal-agent-platformにテストIssueを作成して" },
      { role: "assistant" as const, content: "リポジトリ名をowner/name形式で教えてください。" },
    ];
    const prompt = continuationIntentPrompt("ultimate-1113/open-personal-agent-platform", history);
    expect(selectConnectorToolNames(prompt)).toEqual(["github_issue_create"]);
  });

  it("excludes sensitive conversation data from automatic model context", () => {
    expect(normalConversationContext({ messages: [
      { role: "user", content: "normal", informationPolicy: { sensitivity: "normal" } },
      { role: "assistant", content: "private connector result",
        informationPolicy: { sensitivity: "sensitive" } },
    ] })).toEqual([{ role: "user", content: "normal" }]);
  });

  it("limits a Japanese next-year Calendar request to exactly one year", () => {
    expect(inferCalendarRange("今後1年の予定は？", new Date("2026-08-11T00:00:00.000Z"))).toEqual({
      timeMin: "2026-08-11T00:00:00.000Z",
      timeMax: "2027-08-11T00:00:00.000Z",
    });
  });

  it("places approved connector data in a model-visible user message", () => {
    const messages = connectorSummaryMessages("今後1年の予定は？", "Calendar result: Project meeting");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("今後1年の予定は？");
    expect(messages[1]?.content).toContain("Calendar result: Project meeting");
    expect(messages.some((message) => message.role === "tool")).toBe(false);
  });

  it.each([
    ["最近のメールを3件教えて", "google_gmail_search"],
    ["明日15時にテスト予定を作成して", "google_calendar_create_event"],
    ["今後2年間の予定は？", "google_calendar_list_events"],
    ["対象RepositoryにテストIssueを作成して", "github_issue_create"],
    ["GitHubでアクセス可能なリポジトリは？", "github_repositories_list"],
  ])("routes %s only to %s", (prompt, expected) => {
    expect(selectConnectorToolNames(prompt)).toEqual([expected]);
  });
});
