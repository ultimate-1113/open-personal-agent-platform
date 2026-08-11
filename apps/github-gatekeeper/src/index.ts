import { importJWK, type JWK } from "jose";
import { verifyExecutionLease } from "@opap/approval";
import {
  GitHubApiError,
  createGitHubIssue,
  createGitHubIssueComment,
  getAuthenticatedGitHubUser,
  listGitHubIssueComments,
  listGitHubNotifications,
  listGitHubPullRequests,
  listGitHubRepositories,
  searchGitHubCode,
  searchGitHubIssues,
} from "@opap/github-connector";
import {
  OAUTH_PROVIDERS,
  createAuthorizationStart,
  decryptCredential,
  encryptCredential,
  exchangeAuthorizationCode,
  oauthStateDigest,
  openTransientSecret,
  refreshAccessToken,
  sealTransientSecret,
  verifyAuthorizationCallback,
  type OAuthTransaction,
} from "@opap/oauth-core";

type Bindings = {
  ENVIRONMENT: string;
  GATEKEEPER_DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CREDENTIAL_KEK: string;
  CREDENTIAL_KEY_ID: string;
  EXECUTION_LEASE_PUBLIC_JWK: string;
};

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

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status, headers: { "Cache-Control": "no-store" },
});

const objectBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => null);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
};

const encoder = new TextEncoder();
const hex = (value: ArrayBuffer): string => [...new Uint8Array(value)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const subjectHash = async (env: Bindings, deploymentId: string, subject: string): Promise<string> => {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(env.CREDENTIAL_KEK.trim()));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key,
    encoder.encode(`${deploymentId}\u0000github\u0000${subject}`)));
};

const activeCredential = async (env: Bindings, deploymentId: string, connectionId: string) => {
  const row = await env.GATEKEEPER_DB.prepare(
    `SELECT c.connection_id, e.key_id, e.wrapped_data_key, e.nonce, e.ciphertext
     FROM connections c JOIN encrypted_credentials e
       ON e.deployment_id = c.deployment_id AND e.connection_id = c.connection_id
     WHERE c.deployment_id = ? AND c.connection_id = ? AND c.provider_id = 'github'
       AND c.connection_kind = 'personal' AND c.status = 'active'`,
  ).bind(deploymentId, connectionId).first<CredentialRow>();
  if (!row) return undefined;
  let credential = await decryptCredential({
    envelope: {
      keyId: row.key_id, wrappedDataKey: row.wrapped_data_key,
      nonce: row.nonce, ciphertext: row.ciphertext,
    },
    kek: env.CREDENTIAL_KEK, deploymentId, connectionId,
  });
  const expiry = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiry <= Date.now() + 60_000) {
    credential = await refreshAccessToken({
      provider: OAUTH_PROVIDERS.github,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      credential,
      now: new Date(),
    });
    const envelope = await encryptCredential({
      credential, kek: env.CREDENTIAL_KEK, keyId: env.CREDENTIAL_KEY_ID,
      deploymentId, connectionId,
    });
    await env.GATEKEEPER_DB.prepare(
      `UPDATE encrypted_credentials SET key_id = ?, wrapped_data_key = ?, nonce = ?,
       ciphertext = ?, rotated_at = ? WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(envelope.keyId, envelope.wrappedDataKey, envelope.nonce, envelope.ciphertext,
      new Date().toISOString(), deploymentId, connectionId).run();
  }
  return credential;
};

const start = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["redirectUri"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const now = new Date();
  const started = await createAuthorizationStart({
    provider: OAUTH_PROVIDERS.github,
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri: body["redirectUri"],
    scopes: [],
    connectionKind: "personal",
    now,
    extraParameters: { allow_signup: "false", prompt: "select_account" },
  });
  const context = `${body["deploymentId"]}\u0000${started.transaction.transactionId}`;
  await env.GATEKEEPER_DB.prepare(
    `INSERT INTO oauth_transactions
     (deployment_id, transaction_id, provider_id, connection_kind, state_digest,
      code_verifier_ciphertext, redirect_uri, scopes_json, expires_at, consumed_at, created_at)
     VALUES (?, ?, 'github', 'personal', ?, ?, ?, '[]', ?, NULL, ?)`,
  ).bind(body["deploymentId"], started.transaction.transactionId,
    started.transaction.stateDigest,
    await sealTransientSecret({
      secret: started.transaction.codeVerifier, kek: env.CREDENTIAL_KEK, context,
    }),
    started.transaction.redirectUri, started.transaction.expiresAt, now.toISOString()).run();
  return json({ authorizationUrl: started.authorizationUrl });
};

const callback = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["state"] !== "string" ||
    typeof body["code"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const stateDigest = await oauthStateDigest(body["state"]);
  const row = await env.GATEKEEPER_DB.prepare(
    `SELECT transaction_id, state_digest, code_verifier_ciphertext, connection_kind,
            scopes_json, redirect_uri, expires_at, consumed_at
     FROM oauth_transactions
     WHERE deployment_id = ? AND provider_id = 'github' AND state_digest = ?`,
  ).bind(body["deploymentId"], stateDigest).first<TransactionRow>();
  if (!row || row.consumed_at) return json({ code: "OAUTH_TRANSACTION_INVALID" }, 409);
  const now = new Date();
  const context = `${body["deploymentId"]}\u0000${row.transaction_id}`;
  const transaction: OAuthTransaction = {
    transactionId: row.transaction_id, stateDigest: row.state_digest,
    codeVerifier: await openTransientSecret({
      sealed: row.code_verifier_ciphertext, kek: env.CREDENTIAL_KEK, context,
    }),
    providerId: "github", connectionKind: row.connection_kind,
    requestedScopes: [], redirectUri: row.redirect_uri, expiresAt: row.expires_at,
  };
  await verifyAuthorizationCallback({ transaction, state: body["state"], now });
  const consumed = await env.GATEKEEPER_DB.prepare(
    `UPDATE oauth_transactions SET consumed_at = ?
     WHERE deployment_id = ? AND transaction_id = ? AND consumed_at IS NULL`,
  ).bind(now.toISOString(), body["deploymentId"], row.transaction_id).run();
  if (consumed.meta.changes !== 1) return json({ code: "OAUTH_TRANSACTION_REPLAY" }, 409);
  const credential = await exchangeAuthorizationCode({
    provider: OAUTH_PROVIDERS.github,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code: body["code"], transaction, now,
  });
  const identityValue = await getAuthenticatedGitHubUser({ accessToken: credential.accessToken });
  if (typeof identityValue !== "object" || identityValue === null || Array.isArray(identityValue)) {
    return json({ code: "GITHUB_IDENTITY_INVALID" }, 502);
  }
  const identity = identityValue as Record<string, unknown>;
  if (typeof identity["id"] !== "number" || typeof identity["login"] !== "string") {
    return json({ code: "GITHUB_IDENTITY_INVALID" }, 502);
  }
  const externalSubject = String(identity["id"]);
  const externalSubjectHash = await subjectHash(env, body["deploymentId"], externalSubject);
  const existing = await env.GATEKEEPER_DB.prepare(
    `SELECT connection_id FROM connections
     WHERE deployment_id = ? AND provider_id = 'github' AND connection_kind = 'personal'
       AND external_subject_hash = ? AND status = 'active'`,
  ).bind(body["deploymentId"], externalSubjectHash).first<{ connection_id: string }>();
  const connectionId = existing?.connection_id ?? `connection:github:${crypto.randomUUID()}`;
  const storedCredential = { ...credential, externalSubject };
  const envelope = await encryptCredential({
    credential: storedCredential, kek: env.CREDENTIAL_KEK, keyId: env.CREDENTIAL_KEY_ID,
    deploymentId: body["deploymentId"], connectionId,
  });
  if (existing) {
    await env.GATEKEEPER_DB.batch([
      env.GATEKEEPER_DB.prepare(
        `UPDATE connections SET scopes_json = '[]', account_label = ?, updated_at = ?
         WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(identity["login"], now.toISOString(), body["deploymentId"], connectionId),
      env.GATEKEEPER_DB.prepare(
        `UPDATE encrypted_credentials SET key_id = ?, wrapped_data_key = ?, nonce = ?,
         ciphertext = ?, rotated_at = ? WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(envelope.keyId, envelope.wrappedDataKey, envelope.nonce, envelope.ciphertext,
        now.toISOString(), body["deploymentId"], connectionId),
    ]);
  } else {
    await env.GATEKEEPER_DB.batch([
      env.GATEKEEPER_DB.prepare(
        `INSERT INTO connections
         (deployment_id, connection_id, connection_kind, provider_id, external_subject_hash,
          scopes_json, resource_allowlist_json, status, account_label, created_at, updated_at)
         VALUES (?, ?, 'personal', 'github', ?, '[]', '[]', 'active', ?, ?, ?)`,
      ).bind(body["deploymentId"], connectionId, externalSubjectHash, identity["login"],
        now.toISOString(), now.toISOString()),
      env.GATEKEEPER_DB.prepare(
        `INSERT INTO encrypted_credentials
         (deployment_id, connection_id, key_id, wrapped_data_key, nonce, ciphertext, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(body["deploymentId"], connectionId, envelope.keyId, envelope.wrappedDataKey,
        envelope.nonce, envelope.ciphertext, now.toISOString()),
    ]);
  }
  return json({ connectionId, providerId: "github", accountLabel: identity["login"], status: "active" },
    existing ? 200 : 201);
};

const list = async (request: Request, env: Bindings): Promise<Response> => {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return json({ code: "INVALID_REQUEST" }, 400);
  const rows = await env.GATEKEEPER_DB.prepare(
    `SELECT connection_id, connection_kind, provider_id, scopes_json, status, account_label,
            created_at, updated_at FROM connections
     WHERE deployment_id = ? AND provider_id = 'github' ORDER BY created_at DESC`,
  ).bind(deploymentId).all();
  return json({ connections: rows.results.map((row) => ({
    connectionId: row["connection_id"], kind: row["connection_kind"],
    providerId: row["provider_id"], scopes: [],
    status: row["status"], accountLabel: row["account_label"],
    createdAt: row["created_at"], updatedAt: row["updated_at"],
  })) });
};

const disconnect = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["connectionId"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  await env.GATEKEEPER_DB.batch([
    env.GATEKEEPER_DB.prepare(
      `DELETE FROM encrypted_credentials WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(body["deploymentId"], body["connectionId"]),
    env.GATEKEEPER_DB.prepare(
      `UPDATE connections SET status = 'revoked', updated_at = ?
       WHERE deployment_id = ? AND connection_id = ? AND provider_id = 'github'`,
    ).bind(new Date().toISOString(), body["deploymentId"], body["connectionId"]),
  ]);
  return new Response(null, { status: 204 });
};

const githubRead = async (request: Request, env: Bindings, operation: string): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["connectionId"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const credential = await activeCredential(env, body["deploymentId"], body["connectionId"]);
  if (!credential) return json({ code: "GITHUB_CONNECTION_NOT_FOUND" }, 404);
  const options = { accessToken: credential.accessToken };
  try {
    if (operation === "repositories.list") {
      return json(await listGitHubRepositories({
        ...(typeof body["perPage"] === "number" ? { perPage: body["perPage"] } : {}),
      }, options));
    }
    if ((operation === "issues.search" || operation === "code.search") &&
      typeof body["query"] === "string" && body["query"].length <= 2_048) {
      const input = { query: body["query"], perPage: 20 };
      return json(operation === "issues.search"
        ? await searchGitHubIssues(input, options)
        : await searchGitHubCode(input, options));
    }
    if (operation === "pulls.list" && typeof body["repository"] === "string") {
      return json(await listGitHubPullRequests({ repository: body["repository"], perPage: 20 }, options));
    }
    if (operation === "notifications.list") {
      return json(await listGitHubNotifications({
        all: body["all"] === true,
        participating: body["participating"] === true,
        perPage: 20,
      }, options));
    }
    if (operation === "issue-comments.list" && typeof body["repository"] === "string" &&
      typeof body["issueNumber"] === "number" && Number.isSafeInteger(body["issueNumber"]) &&
      body["issueNumber"] > 0) {
      return json(await listGitHubIssueComments({
        repository: body["repository"], issueNumber: body["issueNumber"], perPage: 20,
      }, options));
    }
    return json({ code: "INVALID_REQUEST" }, 400);
  } catch (error) {
    return error instanceof GitHubApiError
      ? json({ code: "GITHUB_READ_FAILED" }, error.status === 404 ? 404 : 502)
      : json({ code: "GITHUB_READ_FAILED" }, 502);
  }
};

const repositoryPattern = /^(?!\.\.?\/)(?![^/]+\/\.\.?$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
type GitHubWriteInput =
  | { connectionId: string; repository: string; title: string; body: string }
  | { connectionId: string; repository: string; issueNumber: number; body: string };

const writeInput = (capabilityId: string, value: unknown): GitHubWriteInput | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input["connectionId"] !== "string" ||
    typeof input["repository"] !== "string" || !repositoryPattern.test(input["repository"])) return undefined;
  if (capabilityId === "github.issues.create") {
    if (typeof input["title"] !== "string" || input["title"].length === 0 ||
      input["title"].length > 256 || typeof input["body"] !== "string" ||
      input["body"].length > 65_536) return undefined;
    return { connectionId: input["connectionId"], repository: input["repository"],
      title: input["title"], body: input["body"] };
  }
  if (capabilityId === "github.issue-comments.create") {
    if (typeof input["issueNumber"] !== "number" || !Number.isSafeInteger(input["issueNumber"]) ||
      input["issueNumber"] < 1 || typeof input["body"] !== "string" ||
      input["body"].length === 0 || input["body"].length > 65_536) return undefined;
    return { connectionId: input["connectionId"], repository: input["repository"],
      issueNumber: input["issueNumber"], body: input["body"] };
  }
  return undefined;
};

const githubWrite = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || typeof body["deploymentId"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["capabilityId"] !== "string" ||
    typeof body["lease"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  const input = writeInput(body["capabilityId"], body["input"]);
  if (!input) return json({ code: "INVALID_CAPABILITY_INPUT" }, 400);
  const keyValue: unknown = JSON.parse(env.EXECUTION_LEASE_PUBLIC_JWK);
  if (typeof keyValue !== "object" || keyValue === null || Array.isArray(keyValue)) {
    return json({ code: "LEASE_KEY_INVALID" }, 503);
  }
  const claims = await verifyExecutionLease(body["lease"],
    await importJWK(keyValue as JWK, "EdDSA"), {
      issuer: `control:${body["deploymentId"]}`,
      principalId: body["principalId"], capabilityId: body["capabilityId"],
      gatekeeperId: "gatekeeper:github-personal", request: input,
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
  const credential = await activeCredential(env, body["deploymentId"], input.connectionId);
  if (!credential) return json({ code: "GITHUB_CONNECTION_NOT_FOUND" }, 404);
  try {
    const value = body["capabilityId"] === "github.issues.create"
      ? await createGitHubIssue({ repository: input.repository,
          title: "title" in input ? input.title : "", body: input.body },
        { accessToken: credential.accessToken })
      : await createGitHubIssueComment({ repository: input.repository,
          issueNumber: "issueNumber" in input ? input.issueNumber : 0, body: input.body },
        { accessToken: credential.accessToken });
    const result = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const providerRequestId = typeof result["id"] === "number" ? String(result["id"])
      : typeof result["number"] === "number" ? String(result["number"]) : null;
    await env.GATEKEEPER_DB.prepare(
      `UPDATE idempotency_records SET status = 'succeeded', provider_request_id = ?,
       result_reference = ?, updated_at = ? WHERE deployment_id = ? AND idempotency_key = ?`,
    ).bind(providerRequestId, typeof result["html_url"] === "string" ? result["html_url"] : null,
      new Date().toISOString(), body["deploymentId"], claims.jti).run();
    return json({ status: "succeeded", value });
  } catch (error) {
    const status = error instanceof GitHubApiError ? "failed" : "unknown";
    await env.GATEKEEPER_DB.prepare(
      `UPDATE idempotency_records SET status = ?, updated_at = ?
       WHERE deployment_id = ? AND idempotency_key = ?`,
    ).bind(status, new Date().toISOString(), body["deploymentId"], claims.jti).run();
    return json({ code: status === "unknown" ? "EXTERNAL_WRITE_UNKNOWN" : "GITHUB_WRITE_FAILED" },
      status === "unknown" ? 409 : 502);
  }
};

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/v1/oauth/start") return start(request, env);
    if (request.method === "POST" && path === "/internal/v1/oauth/callback") return callback(request, env);
    if (request.method === "GET" && path === "/internal/v1/connections") return list(request, env);
    if (request.method === "DELETE" && path === "/internal/v1/connections") return disconnect(request, env);
    if (request.method === "POST" && path === "/internal/v1/github/repositories/list") {
      return githubRead(request, env, "repositories.list");
    }
    if (request.method === "POST" && path === "/internal/v1/github/issues/search") {
      return githubRead(request, env, "issues.search");
    }
    if (request.method === "POST" && path === "/internal/v1/github/code/search") {
      return githubRead(request, env, "code.search");
    }
    if (request.method === "POST" && path === "/internal/v1/github/pulls/list") {
      return githubRead(request, env, "pulls.list");
    }
    if (request.method === "POST" && path === "/internal/v1/github/notifications/list") {
      return githubRead(request, env, "notifications.list");
    }
    if (request.method === "POST" && path === "/internal/v1/github/issue-comments/list") {
      return githubRead(request, env, "issue-comments.list");
    }
    if (request.method === "POST" && path === "/internal/v1/github/execute") {
      return githubWrite(request, env);
    }
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;
