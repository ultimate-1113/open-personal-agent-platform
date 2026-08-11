import { describe, expect, it, vi } from "vitest";
import {
  OAUTH_PROVIDERS,
  createAuthorizationStart,
  createCredentialKek,
  decryptCredential,
  encryptCredential,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeAccessToken,
  openTransientSecret,
  sealTransientSecret,
  verifyAuthorizationCallback,
} from "./index.js";

const now = new Date("2026-08-11T00:00:00.000Z");

describe("OAuth authorization flow", () => {
  it("omits scopes for a GitHub App user authorization flow", async () => {
    const started = await createAuthorizationStart({
      provider: OAUTH_PROVIDERS.github,
      clientId: "github-client",
      redirectUri: "https://agent.example.test/v1/connections/github/callback",
      scopes: [],
      connectionKind: "personal",
      now,
    });
    expect(new URL(started.authorizationUrl).searchParams.has("scope")).toBe(false);
  });

  it("creates a short-lived state and S256 PKCE challenge", async () => {
    const started = await createAuthorizationStart({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      redirectUri: "https://agent.example.test/v1/connections/google/callback",
      scopes: ["scope:b", "scope:a", "scope:a"],
      connectionKind: "personal",
      now,
      extraParameters: { access_type: "offline" },
    });
    const url = new URL(started.authorizationUrl);

    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(started.transaction.codeVerifier);
    expect(started.transaction.requestedScopes).toEqual(["scope:a", "scope:b"]);
    expect(started.transaction.expiresAt).toBe("2026-08-11T00:10:00.000Z");
  });

  it("rejects state substitution and expired transactions", async () => {
    const started = await createAuthorizationStart({
      provider: OAUTH_PROVIDERS.github,
      clientId: "fixture-client",
      redirectUri: "https://agent.example.test/v1/connections/github/callback",
      scopes: ["repo"],
      connectionKind: "personal",
      now,
    });

    await expect(verifyAuthorizationCallback({
      transaction: started.transaction,
      state: "substituted",
      now,
    })).rejects.toThrow("state mismatch");
    await expect(verifyAuthorizationCallback({
      transaction: started.transaction,
      state: started.state,
      now: new Date("2026-08-11T00:11:00.000Z"),
    })).rejects.toThrow("expired");
    await expect(verifyAuthorizationCallback({
      transaction: started.transaction,
      state: started.state,
      now,
    })).resolves.toBeUndefined();
  });

  it("rejects unsafe redirects, empty scopes, and reserved overrides", async () => {
    await expect(createAuthorizationStart({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      redirectUri: "http://agent.example.test/callback",
      scopes: ["scope:a"],
      connectionKind: "personal",
      now,
    })).rejects.toThrow("HTTPS");
    await expect(createAuthorizationStart({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      redirectUri: "http://localhost/callback",
      scopes: [],
      connectionKind: "personal",
      now,
    })).rejects.toThrow("scope");
    await expect(createAuthorizationStart({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      redirectUri: "https://agent.example.test/callback",
      scopes: ["scope:a"],
      connectionKind: "personal",
      now,
      extraParameters: { state: "override" },
    })).rejects.toThrow("Reserved");
  });

  it("exchanges a code without logging or returning the client secret", async () => {
    const started = await createAuthorizationStart({
      provider: OAUTH_PROVIDERS.discord,
      clientId: "fixture-client",
      redirectUri: "https://agent.example.test/v1/connections/discord/callback",
      scopes: ["identify"],
      connectionKind: "personal",
      now,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: "access-fixture",
      refresh_token: "refresh-fixture",
      token_type: "Bearer",
      scope: "identify",
      expires_in: 3_600,
    }));

    await expect(exchangeAuthorizationCode({
      provider: OAUTH_PROVIDERS.discord,
      clientId: "fixture-client",
      clientSecret: "secret-fixture",
      code: "code-fixture",
      transaction: started.transaction,
      now,
      fetcher,
    })).resolves.toEqual({
      accessToken: "access-fixture",
      refreshToken: "refresh-fixture",
      tokenType: "Bearer",
      scopes: ["identify"],
      expiresAt: "2026-08-11T01:00:00.000Z",
    });
    const request = fetcher.mock.calls[0];
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get("Authorization")).toMatch(/^Basic /u);
    expect(request?.[1]?.body).toBeInstanceOf(URLSearchParams);
    expect((request?.[1]?.body as URLSearchParams).has("client_secret")).toBe(false);
  });

  it("rotates refresh tokens and requires reconsent after provider rejection", async () => {
    const credential = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      scopes: ["identify"],
    };
    const successfulFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 600,
    }));
    await expect(refreshAccessToken({
      provider: OAUTH_PROVIDERS.discord,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential,
      now,
      fetcher: successfulFetch,
    })).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      scopes: ["identify"],
    });

    await expect(refreshAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential,
      now,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 })),
    })).rejects.toThrow("reconsent");
    await expect(refreshAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential: { accessToken: "only-access", tokenType: "Bearer", scopes: [] },
      now,
    })).rejects.toThrow("reconsent");
    await expect(refreshAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential,
      now,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    })).rejects.toMatchObject({ status: 503 });
  });

  it("uses the provider revocation endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await revokeAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential: {
        accessToken: "access-fixture",
        refreshToken: "refresh-fixture",
        tokenType: "Bearer",
        scopes: ["fixture.read"],
      },
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    await expect(revokeAccessToken({
      provider: OAUTH_PROVIDERS.github,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential: {
        accessToken: "access-fixture",
        tokenType: "Bearer",
        scopes: [],
      },
    })).rejects.toThrow("Provider-specific");
    await expect(revokeAccessToken({
      provider: OAUTH_PROVIDERS.discord,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      credential: {
        accessToken: "access-fixture",
        tokenType: "Bearer",
        scopes: [],
      },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })),
    })).rejects.toMatchObject({ status: 500 });
  });
});

describe("OAuth credential envelope encryption", () => {
  it("rejects a low-entropy credential encryption secret", async () => {
    await expect(sealTransientSecret({ secret: "verifier", kek: "short", context: "tx" }))
      .rejects.toThrow("32 characters");
  });

  it("seals a short-lived transaction secret with context binding", async () => {
    const kek = createCredentialKek();
    const sealed = await sealTransientSecret({ secret: "verifier", kek, context: "tx:1" });
    expect(sealed).not.toContain("verifier");
    await expect(openTransientSecret({ sealed, kek, context: "tx:1" }))
      .resolves.toBe("verifier");
    await expect(openTransientSecret({ sealed, kek, context: "tx:2" }))
      .rejects.toThrow();
    await expect(openTransientSecret({ sealed: "invalid", kek, context: "tx:1" }))
      .rejects.toThrow("Invalid");
  });

  it("round-trips a credential and binds it to deployment and connection", async () => {
    const kek = createCredentialKek();
    const credential = {
      accessToken: "access-fixture",
      refreshToken: "refresh-fixture",
      tokenType: "Bearer",
      scopes: ["fixture.read"],
      expiresAt: "2026-08-11T01:00:00.000Z",
    };
    const envelope = await encryptCredential({
      credential,
      kek,
      keyId: "kek:2026-08",
      deploymentId: "deployment:fixture",
      connectionId: "connection:fixture",
    });

    expect(JSON.stringify(envelope)).not.toContain("access-fixture");
    await expect(decryptCredential({
      envelope,
      kek,
      deploymentId: "deployment:fixture",
      connectionId: "connection:fixture",
    })).resolves.toEqual(credential);
    await expect(decryptCredential({
      envelope,
      kek,
      deploymentId: "deployment:fixture",
      connectionId: "connection:other",
    })).rejects.toThrow();
  });
});
