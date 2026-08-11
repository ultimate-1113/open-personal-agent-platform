import { oauthCredentialSchema, type OAuthCredential } from "@opap/contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomBase64Url = (bytes: number): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
};

const sha256Base64Url = async (value: string): Promise<string> =>
  encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));

export const oauthStateDigest = sha256Base64Url;

export async function sealTransientSecret(input: {
  secret: string;
  kek: string;
  context: string;
}): Promise<string> {
  const key = await importKek(input.kek);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(input.context) },
    key,
    encoder.encode(input.secret),
  );
  return `${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openTransientSecret(input: {
  sealed: string;
  kek: string;
  context: string;
}): Promise<string> {
  const [nonce, ciphertext] = input.sealed.split(".");
  if (!nonce || !ciphertext) throw new Error("Invalid sealed secret");
  const key = await importKek(input.kek);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(nonce), additionalData: encoder.encode(input.context) },
    key,
    decodeBase64Url(ciphertext),
  );
  return decoder.decode(plaintext);
}

export type OAuthClientAuthentication = "client-secret-post" | "client-secret-basic";

export type OAuthProvider = {
  id: "google" | "github" | "discord";
  authorizationEndpoint: `https://${string}`;
  tokenEndpoint: `https://${string}`;
  revocationEndpoint?: `https://${string}`;
  clientAuthentication: OAuthClientAuthentication;
  scopeSeparator: " " | ",";
};

export const OAUTH_PROVIDERS: Readonly<Record<OAuthProvider["id"], OAuthProvider>> = {
  google: {
    id: "google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    clientAuthentication: "client-secret-post",
    scopeSeparator: " ",
  },
  github: {
    id: "github",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    clientAuthentication: "client-secret-post",
    scopeSeparator: " ",
  },
  discord: {
    id: "discord",
    authorizationEndpoint: "https://discord.com/oauth2/authorize",
    tokenEndpoint: "https://discord.com/api/oauth2/token",
    revocationEndpoint: "https://discord.com/api/oauth2/token/revoke",
    clientAuthentication: "client-secret-basic",
    scopeSeparator: " ",
  },
};

export type OAuthTransaction = {
  transactionId: string;
  stateDigest: string;
  codeVerifier: string;
  providerId: OAuthProvider["id"];
  connectionKind: "personal" | "delegated-source";
  requestedScopes: readonly string[];
  redirectUri: string;
  expiresAt: string;
};

export type AuthorizationStart = {
  authorizationUrl: string;
  state: string;
  transaction: OAuthTransaction;
};

export async function createAuthorizationStart(input: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  connectionKind: OAuthTransaction["connectionKind"];
  now: Date;
  ttlSeconds?: number;
  extraParameters?: Readonly<Record<string, string>>;
}): Promise<AuthorizationStart> {
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
    throw new Error("OAuth redirect URI must use HTTPS");
  }
  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length === 0 && input.provider.id !== "github") {
    throw new Error("At least one OAuth scope is required");
  }
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const transactionId = `oauth:${randomBase64Url(24)}`;
  const authorization = new URL(input.provider.authorizationEndpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", input.clientId);
  authorization.searchParams.set("redirect_uri", redirect.toString());
  if (scopes.length > 0) {
    authorization.searchParams.set("scope", scopes.join(input.provider.scopeSeparator));
  }
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(input.extraParameters ?? {})) {
    if (["client_id", "redirect_uri", "state", "code_challenge"].includes(key)) {
      throw new Error(`Reserved OAuth parameter: ${key}`);
    }
    authorization.searchParams.set(key, value);
  }
  const ttlSeconds = input.ttlSeconds ?? 600;
  return {
    authorizationUrl: authorization.toString(),
    state,
    transaction: {
      transactionId,
      stateDigest: await sha256Base64Url(state),
      codeVerifier,
      providerId: input.provider.id,
      connectionKind: input.connectionKind,
      requestedScopes: scopes,
      redirectUri: redirect.toString(),
      expiresAt: new Date(input.now.getTime() + ttlSeconds * 1_000).toISOString(),
    },
  };
}

export async function verifyAuthorizationCallback(input: {
  transaction: OAuthTransaction;
  state: string;
  now: Date;
}): Promise<void> {
  if (Date.parse(input.transaction.expiresAt) <= input.now.getTime()) {
    throw new Error("OAuth transaction expired");
  }
  const actual = decodeBase64Url(await sha256Base64Url(input.state));
  const expected = decodeBase64Url(input.transaction.stateDigest);
  let mismatch = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  if (mismatch !== 0) throw new Error("OAuth state mismatch");
}

export type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expires_in?: number;
};

export class OAuthReconsentRequiredError extends Error {
  constructor() {
    super("OAuth reconsent is required");
    this.name = "OAuthReconsentRequiredError";
  }
}

export class OAuthProviderError extends Error {
  readonly status: number;
  readonly providerCode: string | undefined;

  constructor(operation: "exchange" | "refresh" | "revoke", status: number, providerCode?: string) {
    super(`OAuth ${operation} failed (${status})${providerCode ? `: ${providerCode}` : ""}`);
    this.name = "OAuthProviderError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

const credentialFromTokenResponse = (
  value: OAuthTokenResponse,
  fallbackScopes: readonly string[],
  now: Date,
  fallbackRefreshToken?: string,
): OAuthCredential => oauthCredentialSchema.parse({
  accessToken: value.access_token,
  ...(value.refresh_token
    ? { refreshToken: value.refresh_token }
    : fallbackRefreshToken
      ? { refreshToken: fallbackRefreshToken }
      : {}),
  tokenType: value.token_type,
  scopes: value.scope
    ? value.scope.split(/[ ,]+/u).filter(Boolean)
    : [...fallbackScopes],
  ...(value.expires_in === undefined
    ? {}
    : { expiresAt: new Date(now.getTime() + value.expires_in * 1_000).toISOString() }),
});

export async function exchangeAuthorizationCode(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  code: string;
  transaction: OAuthTransaction;
  now: Date;
  fetcher?: typeof fetch;
}): Promise<OAuthCredential> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.transaction.redirectUri,
    client_id: input.clientId,
    code_verifier: input.transaction.codeVerifier,
  });
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (input.provider.clientAuthentication === "client-secret-basic") {
    headers.set("Authorization", `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`);
  } else {
    form.set("client_secret", input.clientSecret);
  }
  const response = await (input.fetcher ?? fetch)(input.provider.tokenEndpoint, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) throw new OAuthProviderError("exchange", response.status);
  const value = await response.json() as OAuthTokenResponse & { error?: unknown };
  if (typeof value.access_token !== "string" || typeof value.token_type !== "string") {
    const providerCode = typeof value.error === "string" && /^[a-z0-9_-]{1,64}$/iu.test(value.error)
      ? value.error : undefined;
    throw new OAuthProviderError("exchange", response.status || 502, providerCode);
  }
  return credentialFromTokenResponse(value, input.transaction.requestedScopes, input.now);
}

export async function refreshAccessToken(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  credential: OAuthCredential;
  now: Date;
  fetcher?: typeof fetch;
}): Promise<OAuthCredential> {
  const current = oauthCredentialSchema.parse(input.credential);
  if (!current.refreshToken) throw new OAuthReconsentRequiredError();
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: input.clientId,
  });
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (input.provider.clientAuthentication === "client-secret-basic") {
    headers.set("Authorization", `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`);
  } else {
    form.set("client_secret", input.clientSecret);
  }
  const response = await (input.fetcher ?? fetch)(input.provider.tokenEndpoint, {
    method: "POST",
    headers,
    body: form,
  });
  if (response.status === 400 || response.status === 401) {
    throw new OAuthReconsentRequiredError();
  }
  if (!response.ok) throw new OAuthProviderError("refresh", response.status);
  return credentialFromTokenResponse(
    await response.json() as OAuthTokenResponse,
    current.scopes,
    input.now,
    current.refreshToken,
  );
}

export async function revokeAccessToken(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  credential: OAuthCredential;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!input.provider.revocationEndpoint) {
    throw new Error(`Provider-specific revocation is required for ${input.provider.id}`);
  }
  const current = oauthCredentialSchema.parse(input.credential);
  const form = new URLSearchParams({ token: current.refreshToken ?? current.accessToken });
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (input.provider.clientAuthentication === "client-secret-basic") {
    headers.set("Authorization", `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`);
  } else {
    form.set("client_id", input.clientId);
    form.set("client_secret", input.clientSecret);
  }
  const response = await (input.fetcher ?? fetch)(input.provider.revocationEndpoint, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) throw new OAuthProviderError("revoke", response.status);
}

export type EncryptedCredentialEnvelope = {
  keyId: string;
  wrappedDataKey: string;
  nonce: string;
  ciphertext: string;
};

const importKek = async (key: string): Promise<CryptoKey> => {
  const normalized = key.trim();
  if (normalized.length < 32) throw new Error("Credential KEK must contain at least 32 characters");
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(normalized));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const aad = (deploymentId: string, connectionId: string, keyId: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(`${deploymentId}\u0000${connectionId}\u0000${keyId}`);

export async function encryptCredential(input: {
  credential: OAuthCredential;
  kek: string;
  keyId: string;
  deploymentId: string;
  connectionId: string;
}): Promise<EncryptedCredentialEnvelope> {
  const credential = oauthCredentialSchema.parse(input.credential);
  const keyEncryptionKey = await importKek(input.kek);
  const dataKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(dataKeyBytes);
  const dataKey = await crypto.subtle.importKey("raw", dataKeyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const associatedData = aad(input.deploymentId, input.connectionId, input.keyId);
  const wrapNonce = new Uint8Array(12);
  const payloadNonce = new Uint8Array(12);
  crypto.getRandomValues(wrapNonce);
  crypto.getRandomValues(payloadNonce);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapNonce, additionalData: associatedData },
    keyEncryptionKey,
    dataKeyBytes,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: payloadNonce, additionalData: associatedData },
    dataKey,
    encoder.encode(JSON.stringify(credential)),
  );
  return {
    keyId: input.keyId,
    wrappedDataKey: `${encodeBase64Url(wrapNonce)}.${encodeBase64Url(new Uint8Array(wrapped))}`,
    nonce: encodeBase64Url(payloadNonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptCredential(input: {
  envelope: EncryptedCredentialEnvelope;
  kek: string;
  deploymentId: string;
  connectionId: string;
}): Promise<OAuthCredential> {
  const [wrapNonceValue, wrappedValue] = input.envelope.wrappedDataKey.split(".");
  if (!wrapNonceValue || !wrappedValue) throw new Error("Invalid wrapped data key");
  const associatedData = aad(input.deploymentId, input.connectionId, input.envelope.keyId);
  const keyEncryptionKey = await importKek(input.kek);
  const dataKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(wrapNonceValue), additionalData: associatedData },
    keyEncryptionKey,
    decodeBase64Url(wrappedValue),
  );
  const dataKey = await crypto.subtle.importKey("raw", dataKeyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(input.envelope.nonce), additionalData: associatedData },
    dataKey,
    decodeBase64Url(input.envelope.ciphertext),
  );
  return oauthCredentialSchema.parse(JSON.parse(decoder.decode(plaintext)) as unknown);
}

export function createCredentialKek(): string {
  return randomBase64Url(32);
}
