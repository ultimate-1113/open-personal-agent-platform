import {
  OAUTH_PROVIDERS,
  createAuthorizationStart,
  decryptCredential,
  encryptCredential,
  exchangeAuthorizationCode,
  oauthStateDigest,
  openTransientSecret,
  revokeAccessToken,
  sealTransientSecret,
  verifyAuthorizationCallback,
  type OAuthTransaction,
} from "@opap/oauth-core";

type Bindings = {
  ENVIRONMENT: string;
  GATEKEEPER_DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CREDENTIAL_KEK: string;
  CREDENTIAL_KEY_ID: string;
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
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;
