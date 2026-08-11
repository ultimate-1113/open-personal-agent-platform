import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GOOGLE_PERSONAL_SCOPES } from "../apps/google-gatekeeper/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const documentation = (["en", "ja"] as const).map((locale) =>
  readFileSync(resolve(
    repositoryRoot,
    "docs",
    locale,
    "operations",
    "connector-provider-setup.md",
  ), "utf8")
);

describe("connector provider documentation", () => {
  it("lists every Google scope requested by the gatekeeper", () => {
    for (const document of documentation) {
      for (const scope of GOOGLE_PERSONAL_SCOPES) expect(document).toContain(scope);
    }
  });

  it("documents callbacks, credentials, and GitHub permission boundaries", () => {
    for (const document of documentation) {
      expect(document).toContain("/v1/connections/google/callback");
      expect(document).toContain("/v1/connections/github/callback");
      expect(document).toContain("GOOGLE_CLIENT_SECRET");
      expect(document).toContain("GITHUB_CLIENT_SECRET");
      expect(document).toContain("CREDENTIAL_KEK");
      expect(document).toMatch(/Contents[^\n]*Read-only/u);
      expect(document).toMatch(/Issues[^\n]*Read and write/u);
      expect(document).toMatch(/Pull requests[^\n]*Read-only/u);
      expect(document).toContain("POST /repos/{owner}/{repo}/issues");
      expect(document).toContain("POST /repos/{owner}/{repo}/issues/{number}/comments");
    }
  });
});
