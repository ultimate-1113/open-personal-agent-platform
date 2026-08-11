import { describe, expect, it } from "vitest";
import type { JwtClaims } from "../packages/identity/src/index.js";
import { createDelegatedApp } from "../apps/delegated-agent-api/src/index.js";

const claims = (subject: string): JwtClaims => ({
  iss: "https://issuer.example",
  sub: subject,
  aud: "opap",
  exp: 2_000_000_000,
});

const bindings = {
  ENVIRONMENT: "test",
  DEPLOYMENT_ID: "deployment:test",
  DELEGATED_ISSUER: "https://issuer.example",
  DELEGATED_AUDIENCE: "opap",
  DELEGATED_JWKS_URI: "https://issuer.example/jwks",
  DELEGATED_PRINCIPAL_HMAC_SECRET: "test-secret",
  CONTROL: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
};

describe("Delegated Agent API", () => {
  it("returns only a source authorized for the current delegated subject", async () => {
    const app = createDelegatedApp({
      authenticate: () => Promise.resolve({
        claims: claims("allowed"),
        principal: {
          principalId: "principal:delegated:allowed",
          deploymentId: "deployment:test",
          kind: "delegated",
          issuer: "https://issuer.example",
          subject: "allowed",
          audienceIds: ["principal:delegated:allowed"],
        },
      }),
      authorizeSource: (_sourceId, identity) =>
        Promise.resolve(identity.claims.sub === "allowed" ? {
          sourceId: "source:delegated",
          sourceType: "drive",
          resourceIds: ["file:allowed"],
        } : undefined),
    });
    const response = await app.request("/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: "source:delegated",
        query: "policy",
        mode: "search",
        maxSources: 5,
      }),
    }, bindings);
    expect(response.status).toBe(200);
    const body = await response.json() as { results: { resourceId: string }[] };
    expect(body.results[0]?.resourceId).toBe("file:allowed");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not expose owner endpoints and rejects unauthorized sources", async () => {
    const app = createDelegatedApp({
      authenticate: () => Promise.resolve({
        claims: claims("denied"),
        principal: {
          principalId: "principal:delegated:denied",
          deploymentId: "deployment:test",
          kind: "delegated",
          issuer: "https://issuer.example",
          subject: "denied",
          audienceIds: ["principal:delegated:denied"],
        },
      }),
      authorizeSource: () => Promise.resolve(undefined),
    });
    expect((await app.request("/v1/conversations", {}, bindings)).status).toBe(404);
    expect((await app.request("/v1/query", {
      method: "POST",
      body: JSON.stringify({ sourceId: "source:delegated", query: "x", mode: "search" }),
    }, bindings)).status).toBe(403);
  });
});
