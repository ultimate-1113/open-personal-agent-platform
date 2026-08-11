import {
  OAUTH_PROVIDERS,
  createAuthorizationStart,
  decryptCredential,
  encryptCredential,
  exchangeAuthorizationCode,
  oauthStateDigest,
  openTransientSecret,
  refreshAccessToken,
  revokeAccessToken,
  sealTransientSecret,
  verifyAuthorizationCallback,
  type OAuthTransaction,
} from "@opap/oauth-core";
import {
  createCalendarEvent,
  createGmailDraft,
  getGmailMessage,
  GoogleApiError,
  listCalendarEvents,
  searchDrive,
  searchGmail,
} from "@opap/google-connector";
import { verifyExecutionLease } from "@opap/approval";
import { importJWK, type JWK } from "jose";

type Bindings = {
  ENVIRONMENT: string;
  GATEKEEPER_DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CREDENTIAL_KEK: string;
  CREDENTIAL_KEY_ID: string;
  EXECUTION_LEASE_PUBLIC_JWK: string;
  GMAIL_DRAFT_ALLOWED_RECIPIENTS: string;
};

export const GOOGLE_PERSONAL_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

type TransactionRow = {
  transaction_id: string;
  state_digest: string;
  code_verifier_ciphertext: string;
  connection_kind: "personal";
  scopes_json: string;
  redirect_uri: string;
  expires_at: string;
  consumed_at: string | null;
};

type CredentialRow = {
  connection_id: string;
  key_id: string;
  wrapped_data_key: string;
  nonce: string;
  ciphertext: string;
};

type GoogleIdentity = {
  subject: string;
  email: string;
};

const encoder = new TextEncoder();

const encodeHex = (value: ArrayBuffer): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const googleIdentity = async (accessToken: string): Promise<GoogleIdentity> => {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
  const value: Record<string, unknown> = await response.json();
  if (typeof value["sub"] !== "string" || typeof value["email"] !== "string" ||
    value["email_verified"] !== true) throw new Error("Google identity is not verified");
  return { subject: value["sub"], email: value["email"] };
};

const subjectHash = async (env: Bindings, deploymentId: string, subject: string): Promise<string> => {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(env.CREDENTIAL_KEK.trim()));
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return encodeHex(await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`${deploymentId}\u0000google\u0000${subject}`),
  ));
};

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status,
  headers: { "Cache-Control": "no-store" },
});

const objectBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => null);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

const activeCredential = async (
  env: Bindings,
  deploymentId: string,
  connectionId: string,
) => {
  const row = await env.GATEKEEPER_DB.prepare(
    `SELECT c.connection_id, e.key_id, e.wrapped_data_key, e.nonce, e.ciphertext
     FROM connections c JOIN encrypted_credentials e
       ON e.deployment_id = c.deployment_id AND e.connection_id = c.connection_id
     WHERE c.deployment_id = ? AND c.connection_id = ? AND c.provider_id = 'google'
       AND c.connection_kind = 'personal' AND c.status = 'active'`,
  ).bind(deploymentId, connectionId).first<CredentialRow>();
  if (!row) return undefined;
  let credential = await decryptCredential({
    envelope: {
      keyId: row.key_id,
      wrappedDataKey: row.wrapped_data_key,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
    },
    kek: env.CREDENTIAL_KEK,
    deploymentId,
    connectionId,
  });
  const expiry = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiry <= Date.now() + 60_000) {
    credential = await refreshAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      credential,
      now: new Date(),
    });
    const envelope = await encryptCredential({
      credential,
      kek: env.CREDENTIAL_KEK,
      keyId: env.CREDENTIAL_KEY_ID,
      deploymentId,
      connectionId,
    });
    await env.GATEKEEPER_DB.prepare(
      `UPDATE encrypted_credentials SET key_id = ?, wrapped_data_key = ?, nonce = ?,
         ciphertext = ?, rotated_at = ? WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(envelope.keyId, envelope.wrappedDataKey, envelope.nonce, envelope.ciphertext,
      new Date().toISOString(), deploymentId, connectionId).run();
  }
  return credential;
};

async function googleRead(request: Request, env: Bindings, operation: string): Promise<Response> {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["connectionId"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const credential = await activeCredential(env, body["deploymentId"], body["connectionId"]);
  if (!credential) return json({ code: "GOOGLE_CONNECTION_NOT_FOUND" }, 404);
  const options = { accessToken: credential.accessToken };
  if (operation === "gmail.search") {
    if (typeof body["query"] !== "string" || body["query"].length > 2_048) {
      return json({ code: "INVALID_REQUEST" }, 400);
    }
    return json(await searchGmail({
      query: body["query"],
      ...(typeof body["maxResults"] === "number" ? { maxResults: body["maxResults"] } : {}),
    }, options));
  }
  if (operation === "gmail.get") {
    if (typeof body["messageId"] !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(body["messageId"])) {
      return json({ code: "INVALID_REQUEST" }, 400);
    }
    return json(await getGmailMessage(body["messageId"], options));
  }
  if (operation === "calendar.events.list") {
    const timeMin = body["timeMin"];
    const timeMax = body["timeMax"];
    if ((timeMin !== undefined && (typeof timeMin !== "string" || Number.isNaN(Date.parse(timeMin)))) ||
      (timeMax !== undefined && (typeof timeMax !== "string" || Number.isNaN(Date.parse(timeMax))))) {
      return json({ code: "INVALID_REQUEST" }, 400);
    }
    return json(await listCalendarEvents({
      ...(typeof body["calendarId"] === "string" ? { calendarId: body["calendarId"] } : {}),
      ...(typeof timeMin === "string" ? { timeMin } : {}),
      ...(typeof timeMax === "string" ? { timeMax } : {}),
      ...(typeof body["maxResults"] === "number" ? { maxResults: body["maxResults"] } : {}),
    }, options));
  }
  if (operation === "drive.files.search") {
    if (body["query"] !== undefined &&
      (typeof body["query"] !== "string" || body["query"].length > 2_048)) {
      return json({ code: "INVALID_REQUEST" }, 400);
    }
    return json(await searchDrive({
      ...(typeof body["query"] === "string" ? { query: body["query"] } : {}),
      ...(typeof body["pageSize"] === "number" ? { pageSize: body["pageSize"] } : {}),
    }, options));
  }
  return json({ code: "CAPABILITY_NOT_FOUND" }, 404);
}

const allowedRecipients = (env: Bindings): Set<string> =>
  new Set(env.GMAIL_DRAFT_ALLOWED_RECIPIENTS.split(",")
    .map((value) => value.trim().toLowerCase()).filter(Boolean));

const writeInput = (
  capabilityId: string,
  value: unknown,
  env: Bindings,
): Record<string, string> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input["connectionId"] !== "string") return undefined;
  if (capabilityId === "google.gmail.drafts.create") {
    if (typeof input["to"] !== "string" || typeof input["subject"] !== "string" ||
      typeof input["body"] !== "string" || input["subject"].length > 998 ||
      input["body"].length > 65_536 ||
      !allowedRecipients(env).has(input["to"].toLowerCase())) return undefined;
    return {
      connectionId: input["connectionId"], to: input["to"],
      subject: input["subject"], body: input["body"],
    };
  }
  if (capabilityId === "google.calendar.events.create") {
    if (typeof input["summary"] !== "string" || input["summary"].length > 1_000 ||
      typeof input["start"] !== "string" || Number.isNaN(Date.parse(input["start"])) ||
      typeof input["end"] !== "string" || Number.isNaN(Date.parse(input["end"])) ||
      Date.parse(input["end"]) <= Date.parse(input["start"]) ||
      (input["description"] !== undefined &&
        (typeof input["description"] !== "string" || input["description"].length > 8_192)) ||
      (input["timeZone"] !== undefined && typeof input["timeZone"] !== "string")) return undefined;
    return {
      connectionId: input["connectionId"], summary: input["summary"],
      start: input["start"], end: input["end"],
      ...(typeof input["description"] === "string" ? { description: input["description"] } : {}),
      ...(typeof input["timeZone"] === "string" ? { timeZone: input["timeZone"] } : {}),
    };
  }
  return undefined;
};

async function googleWrite(request: Request, env: Bindings): Promise<Response> {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["capabilityId"] !== "string" ||
    typeof body["lease"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const input = writeInput(body["capabilityId"], body["input"], env);
  if (!input) return json({ code: "INVALID_CAPABILITY_INPUT" }, 400);
  const keyValue: unknown = JSON.parse(env.EXECUTION_LEASE_PUBLIC_JWK);
  if (typeof keyValue !== "object" || keyValue === null || Array.isArray(keyValue)) {
    return json({ code: "LEASE_KEY_INVALID" }, 503);
  }
  const publicKey = await importJWK(keyValue as JWK, "EdDSA");
  const claims = await verifyExecutionLease(body["lease"], publicKey, {
    issuer: `control:${body["deploymentId"]}`,
    principalId: body["principalId"],
    capabilityId: body["capabilityId"],
    gatekeeperId: "gatekeeper:google-personal",
    request: input,
  });
  if (!claims.approvalId) return json({ code: "APPROVAL_REQUIRED" }, 403);
  const consumed = await env.GATEKEEPER_DB.prepare(
    `INSERT OR IGNORE INTO execution_nonces
     (deployment_id, nonce, capability_id, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(body["deploymentId"], claims.jti, body["capabilityId"],
    new Date(claims.exp * 1_000).toISOString(), new Date().toISOString()).run();
  if (consumed.meta.changes !== 1) return json({ code: "EXECUTION_LEASE_REPLAY" }, 409);
  await env.GATEKEEPER_DB.prepare(
    `INSERT INTO idempotency_records
     (deployment_id, idempotency_key, capability_id, request_digest, status,
      provider_request_id, result_reference, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claimed', NULL, NULL, ?, ?)`,
  ).bind(body["deploymentId"], claims.jti, body["capabilityId"], claims.requestDigest,
    new Date().toISOString(), new Date().toISOString()).run();
  const credential = await activeCredential(env, body["deploymentId"], input["connectionId"] ?? "");
  if (!credential) return json({ code: "GOOGLE_CONNECTION_NOT_FOUND" }, 404);
  try {
    const value = body["capabilityId"] === "google.gmail.drafts.create"
      ? await createGmailDraft({
          to: input["to"] ?? "", subject: input["subject"] ?? "", body: input["body"] ?? "",
        }, { accessToken: credential.accessToken })
      : await createCalendarEvent({
          summary: input["summary"] ?? "", start: input["start"] ?? "", end: input["end"] ?? "",
          ...(input["description"] ? { description: input["description"] } : {}),
          ...(input["timeZone"] ? { timeZone: input["timeZone"] } : {}),
        }, { accessToken: credential.accessToken });
    const result = typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {};
    const providerRequestId = typeof result["id"] === "string" ? result["id"] : null;
    await env.GATEKEEPER_DB.prepare(
      `UPDATE idempotency_records SET status = 'succeeded', provider_request_id = ?,
         result_reference = ?, updated_at = ? WHERE deployment_id = ? AND idempotency_key = ?`,
    ).bind(providerRequestId, providerRequestId, new Date().toISOString(),
      body["deploymentId"], claims.jti).run();
    return json({ status: "succeeded", value });
  } catch (error) {
    const status = error instanceof GoogleApiError ? "failed" : "unknown";
    await env.GATEKEEPER_DB.prepare(
      `UPDATE idempotency_records SET status = ?, updated_at = ?
       WHERE deployment_id = ? AND idempotency_key = ?`,
    ).bind(status, new Date().toISOString(), body["deploymentId"], claims.jti).run();
    return json({ code: status === "unknown" ? "EXTERNAL_WRITE_UNKNOWN" : "GOOGLE_WRITE_FAILED" },
      status === "unknown" ? 409 : 502);
  }
}

async function start(request: Request, env: Bindings): Promise<Response> {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["redirectUri"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const now = new Date();
  const started = await createAuthorizationStart({
    provider: OAUTH_PROVIDERS.google,
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: body["redirectUri"],
    scopes: GOOGLE_PERSONAL_SCOPES,
    connectionKind: "personal",
    now,
    extraParameters: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
  });
  const context = `${body["deploymentId"]}\u0000${started.transaction.transactionId}`;
  await env.GATEKEEPER_DB.prepare(
    `INSERT INTO oauth_transactions
     (deployment_id, transaction_id, provider_id, connection_kind, state_digest,
      code_verifier_ciphertext, redirect_uri, scopes_json, expires_at, consumed_at, created_at)
     VALUES (?, ?, 'google', 'personal', ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    body["deploymentId"], started.transaction.transactionId,
    started.transaction.stateDigest,
    await sealTransientSecret({
      secret: started.transaction.codeVerifier,
      kek: env.CREDENTIAL_KEK,
      context,
    }),
    started.transaction.redirectUri,
    JSON.stringify(started.transaction.requestedScopes),
    started.transaction.expiresAt,
    now.toISOString(),
  ).run();
  return json({ authorizationUrl: started.authorizationUrl });
}

async function callback(request: Request, env: Bindings): Promise<Response> {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["state"] !== "string" ||
    typeof body["code"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const stateDigest = await oauthStateDigest(body["state"]);
  const row = await env.GATEKEEPER_DB.prepare(
    `SELECT transaction_id, state_digest, code_verifier_ciphertext, connection_kind,
            scopes_json, redirect_uri, expires_at, consumed_at
     FROM oauth_transactions
     WHERE deployment_id = ? AND provider_id = 'google' AND state_digest = ?`,
  ).bind(body["deploymentId"], stateDigest).first<TransactionRow>();
  if (!row || row.consumed_at) return json({ code: "OAUTH_TRANSACTION_INVALID" }, 409);
  const now = new Date();
  const context = `${body["deploymentId"]}\u0000${row.transaction_id}`;
  const transaction: OAuthTransaction = {
    transactionId: row.transaction_id,
    stateDigest: row.state_digest,
    codeVerifier: await openTransientSecret({
      sealed: row.code_verifier_ciphertext,
      kek: env.CREDENTIAL_KEK,
      context,
    }),
    providerId: "google",
    connectionKind: row.connection_kind,
    requestedScopes: JSON.parse(row.scopes_json) as string[],
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at,
  };
  await verifyAuthorizationCallback({ transaction, state: body["state"], now });
  const consumed = await env.GATEKEEPER_DB.prepare(
    `UPDATE oauth_transactions SET consumed_at = ?
     WHERE deployment_id = ? AND transaction_id = ? AND consumed_at IS NULL`,
  ).bind(now.toISOString(), body["deploymentId"], row.transaction_id).run();
  if (consumed.meta.changes !== 1) return json({ code: "OAUTH_TRANSACTION_REPLAY" }, 409);
  const credential = await exchangeAuthorizationCode({
    provider: OAUTH_PROVIDERS.google,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    code: body["code"],
    transaction,
    now,
  });
  if (!credential.refreshToken) return json({ code: "OAUTH_RECONSENT_REQUIRED" }, 409);
  const identity = await googleIdentity(credential.accessToken);
  const externalSubjectHash = await subjectHash(env, body["deploymentId"], identity.subject);
  const existing = await env.GATEKEEPER_DB.prepare(
    `SELECT connection_id FROM connections
     WHERE deployment_id = ? AND provider_id = 'google' AND connection_kind = 'personal'
       AND external_subject_hash = ? AND status = 'active'`,
  ).bind(body["deploymentId"], externalSubjectHash).first<{ connection_id: string }>();
  const connectionId = existing?.connection_id ?? `connection:google:${crypto.randomUUID()}`;
  const storedCredential = { ...credential, externalSubject: identity.subject };
  const envelope = await encryptCredential({
    credential: storedCredential,
    kek: env.CREDENTIAL_KEK,
    keyId: env.CREDENTIAL_KEY_ID,
    deploymentId: body["deploymentId"],
    connectionId,
  });
  if (existing) {
    await env.GATEKEEPER_DB.batch([
      env.GATEKEEPER_DB.prepare(
        `UPDATE connections SET scopes_json = ?, account_label = ?, updated_at = ?
         WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(JSON.stringify(storedCredential.scopes), identity.email, now.toISOString(),
        body["deploymentId"], connectionId),
      env.GATEKEEPER_DB.prepare(
        `UPDATE encrypted_credentials
         SET key_id = ?, wrapped_data_key = ?, nonce = ?, ciphertext = ?, rotated_at = ?
         WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(envelope.keyId, envelope.wrappedDataKey, envelope.nonce, envelope.ciphertext,
        now.toISOString(), body["deploymentId"], connectionId),
    ]);
  } else {
    await env.GATEKEEPER_DB.batch([
      env.GATEKEEPER_DB.prepare(
        `INSERT INTO connections
         (deployment_id, connection_id, connection_kind, provider_id, external_subject_hash,
          scopes_json, resource_allowlist_json, status, account_label, created_at, updated_at)
         VALUES (?, ?, 'personal', 'google', ?, ?, '[]', 'active', ?, ?, ?)`,
      ).bind(body["deploymentId"], connectionId, externalSubjectHash,
        JSON.stringify(storedCredential.scopes), identity.email, now.toISOString(), now.toISOString()),
      env.GATEKEEPER_DB.prepare(
        `INSERT INTO encrypted_credentials
         (deployment_id, connection_id, key_id, wrapped_data_key, nonce, ciphertext, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(body["deploymentId"], connectionId, envelope.keyId, envelope.wrappedDataKey,
        envelope.nonce, envelope.ciphertext, now.toISOString()),
    ]);
  }
  return json({ connectionId, providerId: "google", accountLabel: identity.email, status: "active" },
    existing ? 200 : 201);
}

async function list(request: Request, env: Bindings): Promise<Response> {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return json({ code: "INVALID_REQUEST" }, 400);
  const rows = await env.GATEKEEPER_DB.prepare(
    `SELECT connection_id, connection_kind, provider_id, scopes_json, status, account_label,
            created_at, updated_at
     FROM connections WHERE deployment_id = ? AND provider_id = 'google' ORDER BY created_at DESC`,
  ).bind(deploymentId).all();
  return json({ connections: rows.results.map((row) => ({
    connectionId: row["connection_id"],
    kind: row["connection_kind"],
    providerId: row["provider_id"],
    scopes: JSON.parse(String(row["scopes_json"])) as unknown,
    status: row["status"],
    accountLabel: row["account_label"],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
  })) });
}

async function disconnect(request: Request, env: Bindings): Promise<Response> {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["connectionId"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const row = await env.GATEKEEPER_DB.prepare(
    `SELECT key_id, wrapped_data_key, nonce, ciphertext FROM encrypted_credentials
     WHERE deployment_id = ? AND connection_id = ?`,
  ).bind(body["deploymentId"], body["connectionId"]).first<{
    key_id: string; wrapped_data_key: string; nonce: string; ciphertext: string;
  }>();
  if (!row) {
    await env.GATEKEEPER_DB.prepare(
      `UPDATE connections SET status = 'revoked', updated_at = ?
       WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(new Date().toISOString(), body["deploymentId"], body["connectionId"]).run();
    return new Response(null, { status: 204 });
  }
  let remoteRevocation = "succeeded";
  try {
    const credential = await decryptCredential({
      envelope: {
        keyId: row.key_id,
        wrappedDataKey: row.wrapped_data_key,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      },
      kek: env.CREDENTIAL_KEK,
      deploymentId: body["deploymentId"],
      connectionId: body["connectionId"],
    });
    await revokeAccessToken({
      provider: OAUTH_PROVIDERS.google,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      credential,
    });
  } catch {
    // Local credential deletion must still succeed when a legacy key cannot be
    // decrypted or the provider has already invalidated the token.
    remoteRevocation = "failed";
  }
  await env.GATEKEEPER_DB.batch([
    env.GATEKEEPER_DB.prepare(
      `DELETE FROM encrypted_credentials WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(body["deploymentId"], body["connectionId"]),
    env.GATEKEEPER_DB.prepare(
      `UPDATE connections SET status = 'revoked', updated_at = ?
       WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(new Date().toISOString(), body["deploymentId"], body["connectionId"]),
  ]);
  return new Response(null, {
    status: 204,
    headers: { "X-OPAP-Remote-Revocation": remoteRevocation },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/v1/oauth/start") return start(request, env);
    if (request.method === "POST" && path === "/internal/v1/oauth/callback") return callback(request, env);
    if (request.method === "GET" && path === "/internal/v1/connections") return list(request, env);
    if (request.method === "DELETE" && path === "/internal/v1/connections") return disconnect(request, env);
    if (request.method === "POST" && path === "/internal/v1/google/gmail/search") {
      return googleRead(request, env, "gmail.search");
    }
    if (request.method === "POST" && path === "/internal/v1/google/gmail/messages/get") {
      return googleRead(request, env, "gmail.get");
    }
    if (request.method === "POST" && path === "/internal/v1/google/calendar/events/list") {
      return googleRead(request, env, "calendar.events.list");
    }
    if (request.method === "POST" && path === "/internal/v1/google/drive/files/search") {
      return googleRead(request, env, "drive.files.search");
    }
    if (request.method === "POST" && path === "/internal/v1/google/execute") {
      return googleWrite(request, env);
    }
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;
