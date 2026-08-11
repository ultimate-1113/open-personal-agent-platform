import { describe, expect, it, vi } from "vitest";
import {
  createGitHubIssue,
  createGitHubIssueComment,
  getAuthenticatedGitHubUser,
  listGitHubIssueComments,
  listGitHubNotifications,
  listGitHubPullRequests,
  listGitHubRepositories,
  searchGitHubCode,
  searchGitHubIssues,
} from "./index.js";

const response = (value: unknown): Response => Response.json(value);
const calledUrl = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>): URL => {
  const target = fetcher.mock.calls[0]?.[0];
  if (!(target instanceof URL)) throw new Error("Expected URL");
  return target;
};

describe("GitHub connector", () => {
  it("lists only bounded repositories visible to the user access token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([]));
    await listGitHubRepositories({ perPage: 500 }, { accessToken: "token", fetcher });
    expect(calledUrl(fetcher).searchParams.get("per_page")).toBe("50");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-GitHub-Api-Version"))
      .toBe("2026-03-10");
  });

  it("searches code without writing repository contents", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }));
    await searchGitHubCode({ query: "Policy repo:owner/repo" }, { accessToken: "token", fetcher });
    expect(calledUrl(fetcher).pathname).toBe("/search/code");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("creates issues and comments through their narrow endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ number: 12 }))
      .mockResolvedValueOnce(response({ id: 34 }));
    await createGitHubIssue({ repository: "owner/repo", title: "Title", body: "Body" },
      { accessToken: "token", fetcher });
    await createGitHubIssueComment({ repository: "owner/repo", issueNumber: 12, body: "Comment" },
      { accessToken: "token", fetcher });
    expect((fetcher.mock.calls[0]?.[0] as URL).pathname).toBe("/repos/owner/repo/issues");
    expect((fetcher.mock.calls[1]?.[0] as URL).pathname).toBe("/repos/owner/repo/issues/12/comments");
  });

  it("reads notifications and issue conversation comments without marking them read", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    await listGitHubNotifications({ participating: true, perPage: 500 },
      { accessToken: "token", fetcher });
    await listGitHubIssueComments({ repository: "owner/repo", issueNumber: 7 },
      { accessToken: "token", fetcher });
    expect((fetcher.mock.calls[0]?.[0] as URL).pathname).toBe("/notifications");
    expect((fetcher.mock.calls[0]?.[0] as URL).searchParams.get("participating")).toBe("true");
    expect((fetcher.mock.calls[0]?.[0] as URL).searchParams.get("per_page")).toBe("50");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect((fetcher.mock.calls[1]?.[0] as URL).pathname)
      .toBe("/repos/owner/repo/issues/7/comments");
  });

  it("supports user identity, issue search, and bounded pull request listing", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 1, login: "owner" }))
      .mockResolvedValueOnce(response({ items: [] }))
      .mockResolvedValueOnce(response([]));
    await getAuthenticatedGitHubUser({ accessToken: "token", fetcher });
    await searchGitHubIssues({ query: "is:open repo:owner/repo", perPage: 0 },
      { accessToken: "token", fetcher });
    await listGitHubPullRequests({ repository: "owner/repo", state: "all", perPage: 0 },
      { accessToken: "token", fetcher });
    expect((fetcher.mock.calls[0]?.[0] as URL).pathname).toBe("/user");
    expect((fetcher.mock.calls[1]?.[0] as URL).searchParams.get("per_page")).toBe("1");
    expect((fetcher.mock.calls[2]?.[0] as URL).searchParams.get("state")).toBe("all");
  });

  it("rejects invalid repositories and redacts provider response bodies on errors", async () => {
    expect(() => createGitHubIssue({ repository: "../bad", title: "x", body: "y" },
      { accessToken: "token", fetcher: vi.fn<typeof fetch>() })).toThrow("Invalid GitHub repository");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", { status: 403 }));
    await expect(searchGitHubCode({ query: "x" }, { accessToken: "token", fetcher }))
      .rejects.toMatchObject({ name: "GitHubApiError", status: 403, operation: "code.search" });
  });
});
