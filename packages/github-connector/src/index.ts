export type GitHubRequestOptions = {
  accessToken: string;
  fetcher?: typeof fetch;
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(status: number, operation: string) {
    super(`GitHub API ${operation} failed (${status})`);
    this.name = "GitHubApiError";
    this.status = status;
    this.operation = operation;
  }
}

const githubJson = async (
  url: URL,
  operation: string,
  options: GitHubRequestOptions,
  init: RequestInit = {},
): Promise<unknown> => {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${options.accessToken}`);
  headers.set("X-GitHub-Api-Version", "2026-03-10");
  headers.set("User-Agent", "open-personal-agent-platform");
  const response = await (options.fetcher ?? fetch)(url, { ...init, headers });
  if (!response.ok) throw new GitHubApiError(response.status, operation);
  return response.status === 204 ? {} : response.json();
};

const repositoryPath = (repository: string): string => {
  const segments = repository.split("/");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("Invalid GitHub repository");
  }
  return repository.split("/").map(encodeURIComponent).join("/");
};

export const getAuthenticatedGitHubUser = (options: GitHubRequestOptions): Promise<unknown> =>
  githubJson(new URL("https://api.github.com/user"), "user.get", options);

export const listGitHubRepositories = (
  input: { perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "repositories.list", options);
};

export const searchGitHubIssues = (
  input: { query: string; perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", input.query);
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "issues.search", options);
};

export const searchGitHubCode = (
  input: { query: string; perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", input.query);
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "code.search", options);
};

export const listGitHubPullRequests = (
  input: { repository: string; state?: "open" | "closed" | "all"; perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL(`https://api.github.com/repos/${repositoryPath(input.repository)}/pulls`);
  url.searchParams.set("state", input.state ?? "open");
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "pulls.list", options);
};

export const listGitHubNotifications = (
  input: { all?: boolean; participating?: boolean; perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL("https://api.github.com/notifications");
  url.searchParams.set("all", String(input.all ?? false));
  url.searchParams.set("participating", String(input.participating ?? false));
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "notifications.list", options);
};

export const listGitHubIssueComments = (
  input: { repository: string; issueNumber: number; perPage?: number },
  options: GitHubRequestOptions,
): Promise<unknown> => {
  const url = new URL(
    `https://api.github.com/repos/${repositoryPath(input.repository)}/issues/${input.issueNumber}/comments`,
  );
  url.searchParams.set("per_page", String(Math.min(Math.max(input.perPage ?? 20, 1), 50)));
  return githubJson(url, "issue-comments.list", options);
};

export const createGitHubIssue = (
  input: { repository: string; title: string; body: string },
  options: GitHubRequestOptions,
): Promise<unknown> => githubJson(
  new URL(`https://api.github.com/repos/${repositoryPath(input.repository)}/issues`),
  "issues.create",
  options,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, body: input.body }),
  },
);

export const createGitHubIssueComment = (
  input: { repository: string; issueNumber: number; body: string },
  options: GitHubRequestOptions,
): Promise<unknown> => githubJson(
  new URL(`https://api.github.com/repos/${repositoryPath(input.repository)}/issues/${input.issueNumber}/comments`),
  "issue-comments.create",
  options,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: input.body }),
  },
);
