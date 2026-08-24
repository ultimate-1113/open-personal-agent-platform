import { describe, expect, it } from "vitest";
import { createGitHubAppManifest, validateGitHubOAuthCallback } from "./github-manifest.js";

describe("GitHub App manifest", () => {
  it("creates a private least-privilege manifest with a short name", () => {
    const manifest = createGitHubAppManifest({ deploymentName: "opap-test-123456",
      redirectUrl: "http://127.0.0.1:49152/callback",
      oauthCallbackUrl: "https://opap-assistant.example.workers.dev/v1/connections/github/callback" });
    expect(manifest.name).toBe("OPAP opap-test-123456");
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.default_permissions).toEqual({ contents: "read", issues: "write", pull_requests: "read" });
  });

  it("rejects callback URLs that can redirect credentials elsewhere", () => {
    expect(() => validateGitHubOAuthCallback("http://example.com/v1/connections/github/callback")).toThrow();
    expect(() => validateGitHubOAuthCallback("https://example.com/other")).toThrow();
    expect(() => validateGitHubOAuthCallback("https://example.com/v1/connections/github/callback?next=evil")).toThrow();
  });
});
