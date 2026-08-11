import type { DelegatedSourceAcl, Principal } from "@opap/contracts";

const encoder = new TextEncoder();

export class IdentityError extends Error {
  constructor(
    readonly code:
      | "JWT_MALFORMED"
      | "JWT_SIGNATURE_INVALID"
      | "JWT_CLAIMS_INVALID"
      | "OWNER_ACCESS_DENIED"
      | "DELEGATED_ACL_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export type JwtClaims = Readonly<Record<string, unknown>> & {
  iss: string;
  sub: string;
  aud: string | readonly string[];
  exp: number;
};

type JwtHeader = { alg: "RS256"; kid: string };
type JwkWithKid = JsonWebKey & { kid?: string };
type JwksDocument = { keys: JwkWithKid[] };

export type OidcIssuerConfig = {
  issuer: string;
  audiences: readonly string[];
  jwksUri: string;
};

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new IdentityError("JWT_MALFORMED", "JWT contains invalid base64url");
  }
};

const decodeJson = (value: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("JWT_MALFORMED", "JWT contains invalid JSON");
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseHeader = (value: unknown): JwtHeader => {
  if (!isObject(value) || value["alg"] !== "RS256" || typeof value["kid"] !== "string") {
    throw new IdentityError("JWT_MALFORMED", "JWT must use RS256 and include kid");
  }
  return { alg: "RS256", kid: value["kid"] };
};

const audienceMatches = (claim: unknown, expected: readonly string[]): boolean => {
  const values = typeof claim === "string"
    ? [claim]
    : Array.isArray(claim) && claim.every((value) => typeof value === "string")
      ? claim
      : [];
  return values.some((value) => expected.includes(value));
};

const parseClaims = (
  value: unknown,
  config: OidcIssuerConfig,
  nowSeconds: number,
): JwtClaims => {
  if (
    !isObject(value) ||
    value["iss"] !== config.issuer ||
    typeof value["sub"] !== "string" ||
    value["sub"].length === 0 ||
    typeof value["exp"] !== "number" ||
    !Number.isInteger(value["exp"]) ||
    value["exp"] <= nowSeconds ||
    !audienceMatches(value["aud"], config.audiences)
  ) {
    throw new IdentityError("JWT_CLAIMS_INVALID", "JWT issuer, subject, audience or expiry is invalid");
  }
  return value as JwtClaims;
};

export type JwtVerifierOptions = {
  fetcher?: typeof fetch;
  now?: () => Date;
  cacheTtlMs?: number;
};

export class JwtVerifier {
  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;
  readonly #cacheTtlMs: number;
  readonly #jwks = new Map<string, { expiresAt: number; document: JwksDocument }>();

  constructor(options: JwtVerifierOptions = {}) {
    // Some edge runtimes reject a captured native fetch when it is later
    // invoked as an object method with the verifier as its receiver.
    const fetcher = options.fetcher ?? fetch;
    this.#fetcher = (input, init) => fetcher(input, init);
    this.#now = options.now ?? (() => new Date());
    this.#cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  async verify(token: string, config: OidcIssuerConfig): Promise<JwtClaims> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new IdentityError("JWT_MALFORMED", "JWT must have three non-empty parts");
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    const header = parseHeader(decodeJson(encodedHeader));
    const now = this.#now();
    const claims = parseClaims(decodeJson(encodedClaims), config, Math.floor(now.getTime() / 1_000));
    const jwks = await this.#getJwks(config.jwksUri, now.getTime());
    const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk || jwk.kty !== "RSA") {
      throw new IdentityError("JWT_SIGNATURE_INVALID", "JWT signing key is unknown");
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!verified) {
      throw new IdentityError("JWT_SIGNATURE_INVALID", "JWT signature is invalid");
    }
    return claims;
  }

  async #getJwks(uri: string, now: number): Promise<JwksDocument> {
    const cached = this.#jwks.get(uri);
    if (cached && cached.expiresAt > now) return cached.document;
    const response = await this.#fetcher(uri, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new IdentityError("JWT_SIGNATURE_INVALID", "JWKS endpoint is unavailable");
    }
    const value: unknown = await response.json();
    if (!isObject(value) || !Array.isArray(value["keys"])) {
      throw new IdentityError("JWT_SIGNATURE_INVALID", "JWKS response is invalid");
    }
    const document: JwksDocument = { keys: value["keys"] as JwkWithKid[] };
    this.#jwks.set(uri, { document, expiresAt: now + this.#cacheTtlMs });
    return document;
  }
}

export type StoredOwnerIdentity = {
  principalId: string;
  deploymentId: string;
  issuer: string;
  subject: string;
  bootstrappedAt: string;
};

export interface OwnerIdentityRepository {
  get(): Promise<StoredOwnerIdentity | undefined>;
  createIfAbsent(identity: StoredOwnerIdentity): Promise<StoredOwnerIdentity>;
}

export class InMemoryOwnerIdentityRepository implements OwnerIdentityRepository {
  #identity: StoredOwnerIdentity | undefined;

  get(): Promise<StoredOwnerIdentity | undefined> {
    return Promise.resolve(this.#identity);
  }

  createIfAbsent(identity: StoredOwnerIdentity): Promise<StoredOwnerIdentity> {
    this.#identity ??= identity;
    return Promise.resolve(this.#identity);
  }
}

export async function authenticateOwner(input: {
  claims: JwtClaims;
  deploymentId: string;
  ownerEmail: string;
  repository: OwnerIdentityRepository;
  now?: Date;
}): Promise<Principal> {
  const existing = await input.repository.get();
  if (existing) {
    if (existing.issuer !== input.claims.iss || existing.subject !== input.claims.sub) {
      throw new IdentityError("OWNER_ACCESS_DENIED", "JWT does not identify the bootstrapped owner");
    }
    return {
      principalId: existing.principalId,
      deploymentId: existing.deploymentId,
      kind: "owner",
      issuer: existing.issuer,
      subject: existing.subject,
      audienceIds: [existing.principalId],
    };
  }
  const email = input.claims["email"];
  if (typeof email !== "string" || email.toLowerCase() !== input.ownerEmail.toLowerCase()) {
    throw new IdentityError("OWNER_ACCESS_DENIED", "First login email does not match OWNER_EMAIL");
  }
  const stored = await input.repository.createIfAbsent({
    principalId: "principal:owner",
    deploymentId: input.deploymentId,
    issuer: input.claims.iss,
    subject: input.claims.sub,
    bootstrappedAt: (input.now ?? new Date()).toISOString(),
  });
  if (stored.issuer !== input.claims.iss || stored.subject !== input.claims.sub) {
    throw new IdentityError("OWNER_ACCESS_DENIED", "Another owner completed bootstrap first");
  }
  return {
    principalId: stored.principalId,
    deploymentId: stored.deploymentId,
    kind: "owner",
    issuer: stored.issuer,
    subject: stored.subject,
    audienceIds: [stored.principalId],
  };
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");

export async function createDelegatedPrincipal(input: {
  claims: JwtClaims;
  deploymentId: string;
  hmacSecret: string;
}): Promise<Principal> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${input.claims.iss}\u0000${input.claims.sub}`),
  );
  const principalId = `principal:delegated:${hex(digest)}`;
  return {
    principalId,
    deploymentId: input.deploymentId,
    kind: "delegated",
    issuer: input.claims.iss,
    subject: input.claims.sub,
    audienceIds: [principalId],
  };
}

const claimStrings = (claim: unknown): readonly string[] =>
  typeof claim === "string"
    ? [claim]
    : Array.isArray(claim) && claim.every((value) => typeof value === "string")
      ? claim
      : [];

export function evaluateDelegatedSourceAcl(
  acl: DelegatedSourceAcl,
  claims: JwtClaims,
): boolean {
  if (claims.iss !== acl.issuer || !audienceMatches(claims.aud, [acl.audience])) return false;
  return acl.rules.every((rule) => {
    if (rule.claim === "subject") {
      return rule.values.includes(claims.sub);
    }
    if (rule.claim === "group") {
      return claimStrings(claims["group"]).some((group) => rule.values.includes(group));
    }
    if (claims["email_verified"] !== true) return false;
    const email = claims["email"];
    if (typeof email !== "string") return false;
    if (rule.operator === "equals") return rule.values.includes(email);
    const separator = email.lastIndexOf("@");
    if (separator < 0) return false;
    const domain = email.slice(separator + 1).toLowerCase();
    return rule.values.some((value) => value.toLowerCase() === domain);
  });
}
