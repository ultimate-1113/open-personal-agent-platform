import { describe, expect, it } from "vitest";
import type { DelegatedSourceAcl } from "@opap/contracts";
import {
  authenticateOwner,
  createDelegatedPrincipal,
  evaluateDelegatedSourceAcl,
  InMemoryOwnerIdentityRepository,
  JwtVerifier,
  type JwtClaims,
} from "./index.js";

const encode = (value: unknown): string =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const signJwt = async (
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> => {
  const header = encode({ alg: "RS256", kid: "test-key" });
  const payload = encode(claims);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${header}.${payload}.${encodedSignature}`;
};

const claims = (overrides: Record<string, unknown> = {}): JwtClaims => ({
  iss: "https://issuer.example",
  sub: "user-1",
  aud: "opap",
  exp: 2_000_000_000,
  email: "owner@example.com",
  email_verified: true,
  ...overrides,
});

describe("JWT verification", () => {
  it("verifies signature, issuer, audience and expiry with a configured JWKS URL", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-key" };
    const verifier = new JwtVerifier({
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      fetcher: () => Promise.resolve(Response.json({ keys: [jwk] })),
    });
    const token = await signJwt(pair.privateKey, claims());
    await expect(verifier.verify(token, {
      issuer: "https://issuer.example",
      audiences: ["opap"],
      jwksUri: "https://issuer.example/.well-known/jwks.json",
    })).resolves.toMatchObject({ sub: "user-1" });
    const tokenParts = token.split(".");
    const signature = tokenParts[2];
    if (!signature) throw new Error("Test JWT signature is missing");
    const tampered = `${tokenParts[0]}.${tokenParts[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    await expect(verifier.verify(tampered, {
      issuer: "https://issuer.example",
      audiences: ["opap"],
      jwksUri: "https://issuer.example/.well-known/jwks.json",
    })).rejects.toMatchObject({ code: "JWT_SIGNATURE_INVALID" });
  });

  it("rejects expired and wrong-audience tokens before authorization", async () => {
    const verifier = new JwtVerifier({ now: () => new Date("2026-08-07T00:00:00.000Z") });
    const unsigned = (payload: Record<string, unknown>) =>
      `${encode({ alg: "RS256", kid: "test-key" })}.${encode(payload)}.signature`;
    await expect(verifier.verify(unsigned(claims({ exp: 1 })), {
      issuer: "https://issuer.example", audiences: ["opap"], jwksUri: "https://fixed.example/jwks",
    })).rejects.toMatchObject({ code: "JWT_CLAIMS_INVALID" });
    await expect(verifier.verify(unsigned(claims({ aud: "other" })), {
      issuer: "https://issuer.example", audiences: ["opap"], jwksUri: "https://fixed.example/jwks",
    })).rejects.toMatchObject({ code: "JWT_CLAIMS_INVALID" });
  });
});

describe("owner identity", () => {
  it("uses email only for bootstrap and issuer plus subject afterward", async () => {
    const repository = new InMemoryOwnerIdentityRepository();
    const owner = await authenticateOwner({
      claims: claims(), deploymentId: "deployment:test", ownerEmail: "owner@example.com", repository,
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(owner.principalId).toBe("principal:owner");
    await expect(authenticateOwner({
      claims: claims({ email: "renamed@example.com" }), deploymentId: "deployment:test",
      ownerEmail: "owner@example.com", repository,
    })).resolves.toMatchObject({ principalId: "principal:owner" });
    await expect(authenticateOwner({
      claims: claims({ sub: "attacker" }), deploymentId: "deployment:test",
      ownerEmail: "owner@example.com", repository,
    })).rejects.toMatchObject({ code: "OWNER_ACCESS_DENIED" });
  });
});

describe("delegated identity and ACL", () => {
  const acl: DelegatedSourceAcl = {
    issuer: "https://issuer.example",
    audience: "opap",
    rules: [
      { claim: "email", operator: "domain", values: ["example.com"] },
      { claim: "group", operator: "in", values: ["engineering"] },
    ],
  };

  it("derives stable non-reversible IDs and requires every ACL rule", async () => {
    const value = claims({ group: ["engineering"] });
    const first = await createDelegatedPrincipal({ claims: value, deploymentId: "deployment:test", hmacSecret: "secret" });
    const second = await createDelegatedPrincipal({ claims: value, deploymentId: "deployment:test", hmacSecret: "secret" });
    expect(first.principalId).toBe(second.principalId);
    expect(first.principalId).not.toContain("user-1");
    expect(evaluateDelegatedSourceAcl(acl, value)).toBe(true);
    expect(evaluateDelegatedSourceAcl(acl, claims({ group: ["sales"] }))).toBe(false);
    expect(evaluateDelegatedSourceAcl(acl, claims({ group: ["engineering"], email_verified: false }))).toBe(false);
  });
});
