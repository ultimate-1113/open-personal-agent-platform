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
  DELEGATED_SOURCE_READ: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
  DELEGATED_QUOTA: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve(Response.json({ status: "ok" })) }),
  },
};

const informationPolicy = {
  deploymentId: "deployment:test", subjectPrincipalIds: ["principal:delegated:allowed"],
  visibility: "delegated-principal" as const, sensitivity: "normal" as const,
  trust: "external" as const, allowedAudienceIds: ["principal:delegated:allowed"],
  allowedDestinationIds: [], retention: { mode: "none" as const },
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
          sourceType: "google-drive",
          resourceIds: ["file:allowed"],
          connectionId: "connection:test",
          sourceVersion: 1,
          informationPolicy,
          cachePolicy: { enabled: false, ttlSeconds: 60 },
        } : undefined),
      sourceFactory: () => ({ kind: "google-drive", search: () => Promise.resolve([{
        sourceId: "source:delegated", resourceId: "file:allowed", title: "Allowed",
        uri: "https://example.test/allowed", excerpt: "policy", contentDigest: "a".repeat(64),
        observedAt: "2026-08-15T00:00:00.000Z", informationPolicy,
      }]) }),
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
