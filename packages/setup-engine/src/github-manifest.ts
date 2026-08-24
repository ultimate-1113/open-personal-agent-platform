import { validateDeploymentName } from "./index.js";

export type GitHubAppManifest = {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  public: false;
  request_oauth_on_install: true;
  hook_attributes: { active: false };
  default_permissions: {
    contents: "read";
    issues: "write";
    pull_requests: "read";
  };
};

export function validateGitHubOAuthCallback(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/v1/connections/github/callback") {
    throw new Error("GitHub callback must be an HTTPS /v1/connections/github/callback URL");
  }
  return url.toString();
}

export function createGitHubAppManifest(input: {
  deploymentName: string;
  redirectUrl: string;
  oauthCallbackUrl: string;
}): GitHubAppManifest {
  validateDeploymentName(input.deploymentName);
  const redirect = new URL(input.redirectUrl);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1"
    || redirect.pathname !== "/callback") throw new Error("Manifest redirect must use the Installer loopback callback");
  const callback = validateGitHubOAuthCallback(input.oauthCallbackUrl);
  return {
    name: `OPAP ${input.deploymentName}`,
    url: "https://github.com/ultimate-1113/open-personal-agent-platform",
    redirect_url: redirect.toString(),
    callback_urls: [callback],
    public: false,
    request_oauth_on_install: true,
    hook_attributes: { active: false },
    default_permissions: { contents: "read", issues: "write", pull_requests: "read" },
  };
}
