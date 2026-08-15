import { WorkerEntrypoint } from "cloudflare:workers";
import {
  OAUTH_PROVIDERS,
  OAuthProviderError,
  OAuthReconsentRequiredError,
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

type ProviderId = "google" | "github";

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  SOURCE_DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CREDENTIAL_KEK: string;
  CREDENTIAL_KEY_ID: string;
};

type TransactionRow = {
  transaction_id: string;
  provider_id: ProviderId;
  state_digest: string;
  code_verifier_ciphertext: string;
  redirect_uri: string;
  scopes_json: string;
  resource_allowlist_json: string;
  expires_at: string;
  consumed_at: string | null;
};

type CredentialRow = {
  provider_id: ProviderId;
  connection_id: string;
  resource_allowlist_json: string;
  key_id: string;
  wrapped_data_key: string;
  nonce: string;
  ciphertext: string;
};

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status, headers: { "Cache-Control": "no-store" },
});

const parseStoredJson = (value: unknown): unknown => JSON.parse(String(value)) as unknown;

const bodyObject = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => null);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
};

const providerScopes = (providerId: ProviderId): readonly string[] => providerId === "google"
  ? ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/drive.readonly"]
  : [];

const resourcePattern = (providerId: ProviderId): RegExp => providerId === "github"
  ? /^(?!\.\.?\/)(?![^/]+\/\.\.?$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
  : /^[A-Za-z0-9_-]{10,200}$/u;

const resourceAllowlist = (value: unknown, providerId: ProviderId): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return undefined;
  const resources = [...new Set(value)];
  if (resources.some((item) => typeof item !== "string" || !resourcePattern(providerId).test(item))) {
    return undefined;
  }
  return (resources as string[]).sort();
};

const client = (env: Bindings, providerId: ProviderId) => providerId === "google"
  ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
  : { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };

const encoder = new TextEncoder();
const hex = (value: ArrayBuffer): string => [...new Uint8Array(value)]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const subjectHash = async (env: Bindings, providerId: ProviderId, subject: string): Promise<string> => {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(env.CREDENTIAL_KEK.trim()));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key,
    encoder.encode(`${env.DEPLOYMENT_ID}\u0000delegated-source\u0000${providerId}\u0000${subject}`)));
};

const beginOAuth = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await bodyObject(request);
  const providerId = body?.["providerId"];
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    (providerId !== "google" && providerId !== "github") || typeof body["redirectUri"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const resources = resourceAllowlist(body["resourceIds"], providerId);
  if (!resources) return json({ code: "RESOURCE_ALLOWLIST_REQUIRED" }, 400);
  const provider = OAUTH_PROVIDERS[providerId];
  const selected = client(env, providerId);
  const now = new Date();
  const started = await createAuthorizationStart({
    provider, clientId: selected.id, redirectUri: body["redirectUri"],
    scopes: providerScopes(providerId), connectionKind: "delegated-source", now,
    extraParameters: providerId === "google"
      ? { access_type: "offline", prompt: "consent", include_granted_scopes: "false" }
      : { allow_signup: "false", prompt: "select_account" },
  });
  const context = `${env.DEPLOYMENT_ID}\u0000${started.transaction.transactionId}`;
  await env.SOURCE_DB.prepare(
    `INSERT INTO source_oauth_transactions
     (deployment_id, transaction_id, provider_id, state_digest, code_verifier_ciphertext,
      redirect_uri, scopes_json, resource_allowlist_json, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(env.DEPLOYMENT_ID, started.transaction.transactionId, providerId,
    started.transaction.stateDigest, await sealTransientSecret({
      secret: started.transaction.codeVerifier, kek: env.CREDENTIAL_KEK, context,
    }), started.transaction.redirectUri, JSON.stringify(started.transaction.requestedScopes),
    JSON.stringify(resources), started.transaction.expiresAt, now.toISOString()).run();
  return json({ authorizationUrl: started.authorizationUrl });
};

const providerIdentity = async (providerId: ProviderId, accessToken: string): Promise<{
  subject: string; label: string;
}> => {
  const url = providerId === "google"
    ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://api.github.com/user";
  const response = await fetch(url, { headers: {
    Authorization: `Bearer ${accessToken}`, Accept: "application/json",
    ...(providerId === "github" ? { "User-Agent": "open-personal-agent-platform",
      "X-GitHub-Api-Version": "2026-03-10" } : {}),
  } });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider identity unavailable");
  }
  const row = value as Record<string, unknown>;
  if (providerId === "google" && typeof row["sub"] === "string" && typeof row["email"] === "string") {
    return { subject: row["sub"], label: row["email"] };
  }
  if (providerId === "github" && typeof row["id"] === "number" && typeof row["login"] === "string") {
    return { subject: String(row["id"]), label: row["login"] };
  }
  throw new Error("Provider identity invalid");
};

const finishOAuth = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await bodyObject(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    typeof body["state"] !== "string" || typeof body["code"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const digest = await oauthStateDigest(body["state"]);
  const row = await env.SOURCE_DB.prepare(
    `SELECT transaction_id, provider_id, state_digest, code_verifier_ciphertext, redirect_uri,
            scopes_json, resource_allowlist_json, expires_at, consumed_at
     FROM source_oauth_transactions WHERE deployment_id = ? AND state_digest = ?`,
  ).bind(env.DEPLOYMENT_ID, digest).first<TransactionRow>();
  if (!row || row.consumed_at) return json({ code: "OAUTH_TRANSACTION_INVALID" }, 409);
  const now = new Date();
  const transaction: OAuthTransaction = {
    transactionId: row.transaction_id, stateDigest: row.state_digest,
    codeVerifier: await openTransientSecret({ sealed: row.code_verifier_ciphertext,
      kek: env.CREDENTIAL_KEK, context: `${env.DEPLOYMENT_ID}\u0000${row.transaction_id}` }),
    providerId: row.provider_id, connectionKind: "delegated-source",
    requestedScopes: JSON.parse(row.scopes_json) as string[], redirectUri: row.redirect_uri,
    expiresAt: row.expires_at,
  };
  await verifyAuthorizationCallback({ transaction, state: body["state"], now });
  const consumed = await env.SOURCE_DB.prepare(
    `UPDATE source_oauth_transactions SET consumed_at = ?
     WHERE deployment_id = ? AND transaction_id = ? AND consumed_at IS NULL`,
  ).bind(now.toISOString(), env.DEPLOYMENT_ID, row.transaction_id).run();
  if (consumed.meta.changes !== 1) return json({ code: "OAUTH_TRANSACTION_REPLAY" }, 409);
  const selected = client(env, row.provider_id);
  let credential;
  try {
    credential = await exchangeAuthorizationCode({ provider: OAUTH_PROVIDERS[row.provider_id],
      clientId: selected.id, clientSecret: selected.secret, code: body["code"], transaction, now });
  } catch (error) {
    return error instanceof OAuthProviderError
      ? json({ code: "OAUTH_EXCHANGE_REJECTED" }, 502) : json({ code: "OAUTH_CALLBACK_FAILED" }, 502);
  }
  const identity = await providerIdentity(row.provider_id, credential.accessToken);
  const externalSubjectHash = await subjectHash(env, row.provider_id, identity.subject);
  const existing = await env.SOURCE_DB.prepare(
    `SELECT connection_id FROM source_connections
     WHERE deployment_id = ? AND provider_id = ? AND external_subject_hash = ?`,
  ).bind(env.DEPLOYMENT_ID, row.provider_id, externalSubjectHash)
    .first<{ connection_id: string }>();
  const connectionId = existing?.connection_id ?? `source-connection:${row.provider_id}:${crypto.randomUUID()}`;
  const envelope = await encryptCredential({ credential: { ...credential, externalSubject: identity.subject },
    kek: env.CREDENTIAL_KEK, keyId: env.CREDENTIAL_KEY_ID,
    deploymentId: env.DEPLOYMENT_ID, connectionId });
  const resources = JSON.parse(row.resource_allowlist_json) as string[];
  if (existing) {
    await env.SOURCE_DB.batch([
      env.SOURCE_DB.prepare(
        `UPDATE source_connections SET account_label = ?, scopes_json = ?, resource_allowlist_json = ?,
          status = 'active', updated_at = ? WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(identity.label, JSON.stringify(credential.scopes), JSON.stringify(resources), now.toISOString(),
        env.DEPLOYMENT_ID, connectionId),
      env.SOURCE_DB.prepare(
        `INSERT INTO source_encrypted_credentials
         (deployment_id, connection_id, key_id, wrapped_data_key, nonce, ciphertext, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (deployment_id, connection_id) DO UPDATE SET
           key_id = excluded.key_id, wrapped_data_key = excluded.wrapped_data_key,
           nonce = excluded.nonce, ciphertext = excluded.ciphertext, rotated_at = excluded.rotated_at`,
      ).bind(env.DEPLOYMENT_ID, connectionId, envelope.keyId, envelope.wrappedDataKey,
        envelope.nonce, envelope.ciphertext, now.toISOString(), now.toISOString()),
    ]);
  } else {
    await env.SOURCE_DB.batch([
      env.SOURCE_DB.prepare(
        `INSERT INTO source_connections
         (deployment_id, connection_id, provider_id, external_subject_hash, account_label,
          scopes_json, resource_allowlist_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(env.DEPLOYMENT_ID, connectionId, row.provider_id, externalSubjectHash, identity.label,
        JSON.stringify(credential.scopes), JSON.stringify(resources), now.toISOString(), now.toISOString()),
      env.SOURCE_DB.prepare(
        `INSERT INTO source_encrypted_credentials
         (deployment_id, connection_id, key_id, wrapped_data_key, nonce, ciphertext, created_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(env.DEPLOYMENT_ID, connectionId, envelope.keyId, envelope.wrappedDataKey,
        envelope.nonce, envelope.ciphertext, now.toISOString()),
    ]);
  }
  return json({ connectionId, providerId: row.provider_id, accountLabel: identity.label,
    resourceIds: resources, status: "active" }, existing ? 200 : 201);
};

const activeCredential = async (env: Bindings, connectionId: string): Promise<{
  providerId: ProviderId; resourceIds: string[]; accessToken: string;
} | undefined> => {
  const row = await env.SOURCE_DB.prepare(
    `SELECT c.provider_id, c.connection_id, c.resource_allowlist_json,
            e.key_id, e.wrapped_data_key, e.nonce, e.ciphertext
     FROM source_connections c JOIN source_encrypted_credentials e
       ON e.deployment_id = c.deployment_id AND e.connection_id = c.connection_id
     WHERE c.deployment_id = ? AND c.connection_id = ? AND c.status = 'active'`,
  ).bind(env.DEPLOYMENT_ID, connectionId).first<CredentialRow>();
  if (!row) return undefined;
  let credential = await decryptCredential({ envelope: { keyId: row.key_id,
    wrappedDataKey: row.wrapped_data_key, nonce: row.nonce, ciphertext: row.ciphertext },
  kek: env.CREDENTIAL_KEK, deploymentId: env.DEPLOYMENT_ID, connectionId });
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now() + 60_000) {
    const selected = client(env, row.provider_id);
    try {
      credential = await refreshAccessToken({ provider: OAUTH_PROVIDERS[row.provider_id],
        clientId: selected.id, clientSecret: selected.secret, credential, now: new Date() });
    } catch (error) {
      if (!(error instanceof OAuthReconsentRequiredError)) throw error;
      await env.SOURCE_DB.prepare(
        `UPDATE source_connections SET status = 'expired', updated_at = ?
         WHERE deployment_id = ? AND connection_id = ?`,
      ).bind(new Date().toISOString(), env.DEPLOYMENT_ID, connectionId).run();
      return undefined;
    }
    const envelope = await encryptCredential({ credential, kek: env.CREDENTIAL_KEK,
      keyId: env.CREDENTIAL_KEY_ID, deploymentId: env.DEPLOYMENT_ID, connectionId });
    await env.SOURCE_DB.prepare(
      `UPDATE source_encrypted_credentials SET key_id = ?, wrapped_data_key = ?, nonce = ?,
       ciphertext = ?, rotated_at = ? WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(envelope.keyId, envelope.wrappedDataKey, envelope.nonce, envelope.ciphertext,
      new Date().toISOString(), env.DEPLOYMENT_ID, connectionId).run();
  }
  return { providerId: row.provider_id,
    resourceIds: JSON.parse(row.resource_allowlist_json) as string[], accessToken: credential.accessToken };
};

const providerFetch = async (url: URL, providerId: ProviderId, accessToken: string): Promise<Response> => {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`,
    Accept: "application/json", ...(providerId === "github" ? {
      "User-Agent": "open-personal-agent-platform", "X-GitHub-Api-Version": "2026-03-10",
    } : {}) } });
  if (!response.ok) return json({ code: "SOURCE_READ_FAILED" }, response.status === 404 ? 404 : 502);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 1_048_576) return json({ code: "SOURCE_RESULT_TOO_LARGE" }, 413);
  return new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};

const githubRecords = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.flatMap((item) => typeof item === "object" && item !== null && !Array.isArray(item)
    ? [item as Record<string, unknown>] : [])
  : [];

const githubJsonRecordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

const githubSearchTerms = (query: string): string[] => [...new Set(query.normalize("NFKC")
  .toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((term) => term.length >= 2))].slice(0, 8);

const githubMatches = (terms: readonly string[], ...values: unknown[]): boolean => {
  const searchable = values.filter((value): value is string => typeof value === "string")
    .join("\n").normalize("NFKC").toLocaleLowerCase();
  return terms.length > 0 && terms.some((term) => searchable.includes(term));
};

export const githubTreeFallbackItems = (input: {
  query: string;
  resourceId: string;
  defaultBranch: string;
  tree: unknown;
  maximum: number;
}): Record<string, unknown>[] => {
  const terms = githubSearchTerms(input.query);
  const output: Record<string, unknown>[] = [];
  for (const item of githubRecords(input.tree)) {
    if (output.length >= input.maximum || item["type"] !== "blob" ||
      !githubMatches(terms, item["path"])) continue;
    const path = String(item["path"]);
    output.push({
      path,
      html_url: `https://github.com/${input.resourceId}/blob/${encodeURIComponent(input.defaultBranch)}/${path
        .split("/").map(encodeURIComponent).join("/")}`,
      text_matches: [{ fragment: path }],
    });
  }
  return output;
};

export const githubIssueFallbackItems = (query: string, issues: unknown,
  maximum: number): Record<string, unknown>[] => {
  const terms = githubSearchTerms(query);
  return githubRecords(issues).filter((item) =>
    githubMatches(terms, item["title"], item["body"])).slice(0, maximum);
};

const githubJsonRecord = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await response.json().catch(() => null);
  return githubJsonRecordValue(value);
};

const decodeGitHubContent = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 1_400_000) return "";
  try {
    const binary = atob(value.replaceAll(/\s/gu, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { return ""; }
};

const googleValue = async (url: URL, accessToken: string): Promise<Record<string, unknown> | undefined> => {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const value: unknown = await response.json().catch(() => null);
  return response.ok && typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
};

const googleFileContent = async (body: Record<string, unknown>, resourceId: string,
  accessToken: string): Promise<Response> => {
  const fileId = typeof body["fileId"] === "string" ? body["fileId"] : resourceId;
  if (!/^[A-Za-z0-9_-]{10,200}$/u.test(fileId)) return json({ code: "INVALID_REQUEST" }, 400);
  const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  metadataUrl.searchParams.set("fields", "id,name,mimeType,parents,modifiedTime,webViewLink");
  const metadata = await googleValue(metadataUrl, accessToken);
  if (!metadata || typeof metadata["mimeType"] !== "string" || typeof metadata["name"] !== "string") {
    return json({ code: "SOURCE_READ_FAILED" }, 502);
  }
  if (fileId !== resourceId && (!Array.isArray(metadata["parents"]) ||
    !metadata["parents"].includes(resourceId))) return json({ code: "RESOURCE_SCOPE_DENIED" }, 403);
  const mimeType = metadata["mimeType"];
  let contentUrl: URL;
  if (mimeType === "application/vnd.google-apps.document") {
    contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    contentUrl.searchParams.set("mimeType", "text/plain");
  } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
    contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    contentUrl.searchParams.set("mimeType", "text/csv");
  } else if (mimeType.startsWith("text/") || mimeType === "application/json") {
    contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    contentUrl.searchParams.set("alt", "media");
  } else {
    return json({ code: "SOURCE_CONTENT_UNSUPPORTED" }, 415);
  }
  const response = await fetch(contentUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return json({ code: "SOURCE_READ_FAILED" }, response.status === 404 ? 404 : 502);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1_048_576) return json({ code: "SOURCE_RESULT_TOO_LARGE" }, 413);
  return json({ resourceId, fileId, title: metadata["name"], mimeType,
    modifiedTime: metadata["modifiedTime"], uri: metadata["webViewLink"],
    content: new TextDecoder().decode(bytes) });
};

const readSource = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await bodyObject(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID || typeof body["connectionId"] !== "string" ||
    typeof body["resourceId"] !== "string" || typeof body["operation"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const active = await activeCredential(env, body["connectionId"]);
  if (!active) return json({ code: "SOURCE_CONNECTION_NOT_FOUND" }, 404);
  if (!active.resourceIds.includes(body["resourceId"])) return json({ code: "RESOURCE_SCOPE_DENIED" }, 403);
  if (active.providerId === "google") {
    if (body["operation"] === "file.get") {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body["resourceId"])}`);
      url.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,description");
      return providerFetch(url, "google", active.accessToken);
    }
    if (body["operation"] === "file.content") {
      return googleFileContent(body, body["resourceId"], active.accessToken);
    }
    if (body["operation"] === "folder.list") {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      const query = typeof body["query"] === "string" && body["query"].length <= 256
        ? body["query"].replaceAll("'", "\\'") : "";
      url.searchParams.set("q", `'${body["resourceId"]}' in parents and trashed = false${query ? ` and name contains '${query}'` : ""}`);
      url.searchParams.set("pageSize", String(Math.min(Math.max(Number(body["maxResults"]) || 20, 1), 50)));
      url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink)");
      return providerFetch(url, "google", active.accessToken);
    }
    if (body["operation"] === "folder.search") {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      const query = typeof body["query"] === "string" && body["query"].length <= 256
        ? body["query"].replaceAll("'", "\\'") : "";
      if (!query) return json({ code: "INVALID_REQUEST" }, 400);
      url.searchParams.set("q", `'${body["resourceId"]}' in parents and trashed = false and fullText contains '${query}'`);
      url.searchParams.set("pageSize", String(Math.min(Math.max(Number(body["maxResults"]) || 20, 1), 20)));
      url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink,description,parents)");
      return providerFetch(url, "google", active.accessToken);
    }
  } else {
    const repository = body["resourceId"].split("/").map(encodeURIComponent).join("/");
    if (body["operation"] === "repository.get") {
      return providerFetch(new URL(`https://api.github.com/repos/${repository}`), "github", active.accessToken);
    }
    if (body["operation"] === "issues.list") {
      const url = new URL(`https://api.github.com/repos/${repository}/issues`);
      url.searchParams.set("state", body["state"] === "closed" ? "closed" : "open");
      url.searchParams.set("per_page", String(Math.min(Math.max(Number(body["maxResults"]) || 20, 1), 50)));
      return providerFetch(url, "github", active.accessToken);
    }
    if (body["operation"] === "contents.get" && typeof body["path"] === "string" &&
      body["path"].length <= 1_024 && !body["path"].split("/").includes("..")) {
      const path = body["path"].split("/").map(encodeURIComponent).join("/");
      return providerFetch(new URL(`https://api.github.com/repos/${repository}/contents/${path}`),
        "github", active.accessToken);
    }
    if (body["operation"] === "repository.search" && typeof body["query"] === "string" &&
      body["query"].length > 0 && body["query"].length <= 256) {
      const maximum = Math.min(Math.max(Number(body["maxResults"]) || 20, 1), 20);
      const qualifier = `${body["query"]} repo:${body["resourceId"]}`;
      const codeUrl = new URL("https://api.github.com/search/code");
      codeUrl.searchParams.set("q", qualifier);
      codeUrl.searchParams.set("per_page", String(maximum));
      const issuesUrl = new URL("https://api.github.com/search/issues");
      issuesUrl.searchParams.set("q", qualifier);
      issuesUrl.searchParams.set("per_page", String(maximum));
      const headers = { Authorization: `Bearer ${active.accessToken}`,
        Accept: "application/vnd.github.text-match+json", "User-Agent": "open-personal-agent-platform",
        "X-GitHub-Api-Version": "2026-03-10" };
      const [codeResponse, issuesResponse] = await Promise.all([
        fetch(codeUrl, { headers }), fetch(issuesUrl, { headers }),
      ]);
      if (!codeResponse.ok || !issuesResponse.ok) {
        console.warn("Delegated GitHub search request was partially rejected", {
          codeStatus: codeResponse.status,
          issuesStatus: issuesResponse.status,
          codeAcceptedPermissions: codeResponse.headers.get("x-accepted-github-permissions"),
          issuesAcceptedPermissions: issuesResponse.headers.get("x-accepted-github-permissions"),
        });
      }
      if (!codeResponse.ok && !issuesResponse.ok) return json({ code: "SOURCE_READ_FAILED" }, 502);
      let [code, issues] = await Promise.all([
        codeResponse.ok ? codeResponse.json().catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        issuesResponse.ok ? issuesResponse.json().catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      ]);
      const codeItems = githubRecords(githubJsonRecordValue(code)?.["items"]);
      const issueItems = githubRecords(githubJsonRecordValue(issues)?.["items"]);
      if (codeItems.length === 0) {
        const repositoryResponse = await fetch(`https://api.github.com/repos/${repository}`, { headers });
        const repositoryValue = repositoryResponse.ok
          ? await githubJsonRecord(repositoryResponse) : undefined;
        const defaultBranch = typeof repositoryValue?.["default_branch"] === "string"
          ? repositoryValue["default_branch"] : undefined;
        let fallbackItems: Record<string, unknown>[] = [];
        if (defaultBranch) {
          const treeUrl = new URL(`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(defaultBranch)}`);
          treeUrl.searchParams.set("recursive", "1");
          const treeResponse = await fetch(treeUrl, { headers });
          const treeValue = treeResponse.ok ? await githubJsonRecord(treeResponse) : undefined;
          fallbackItems = githubTreeFallbackItems({ query: body["query"],
            resourceId: body["resourceId"], defaultBranch, tree: treeValue?.["tree"], maximum });
          if (fallbackItems.length === 0) {
            const readmeResponse = await fetch(`https://api.github.com/repos/${repository}/readme`, { headers });
            const readme = readmeResponse.ok ? await githubJsonRecord(readmeResponse) : undefined;
            const path = typeof readme?.["path"] === "string" ? readme["path"] : undefined;
            const uri = typeof readme?.["html_url"] === "string" ? readme["html_url"] : undefined;
            const content = decodeGitHubContent(readme?.["content"]);
            if (path && uri) fallbackItems.push({ path, html_url: uri,
              text_matches: [{ fragment: content ? content.slice(0, 32_768) : path }] });
          }
        }
        code = { total_count: fallbackItems.length, incomplete_results: false, items: fallbackItems };
      }
      if (issueItems.length === 0) {
        const issueListUrl = new URL(`https://api.github.com/repos/${repository}/issues`);
        issueListUrl.searchParams.set("state", "all");
        issueListUrl.searchParams.set("sort", "updated");
        issueListUrl.searchParams.set("per_page", "50");
        const issueListResponse = await fetch(issueListUrl, { headers });
        const listed: unknown = issueListResponse.ok
          ? await issueListResponse.json().catch(() => []) : [];
        const fallbackIssues = githubIssueFallbackItems(body["query"], listed, maximum);
        issues = { total_count: fallbackIssues.length, incomplete_results: false, items: fallbackIssues };
      }
      const output = JSON.stringify({ repository: body["resourceId"], code, issues });
      if (new TextEncoder().encode(output).byteLength > 1_048_576) {
        return json({ code: "SOURCE_RESULT_TOO_LARGE" }, 413);
      }
      return new Response(output, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }
  return json({ code: "SOURCE_OPERATION_DENIED" }, 403);
};

const listConnections = async (request: Request, env: Bindings): Promise<Response> => {
  if (new URL(request.url).searchParams.get("deploymentId") !== env.DEPLOYMENT_ID) {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const rows = await env.SOURCE_DB.prepare(
    `SELECT connection_id, provider_id, account_label, scopes_json, resource_allowlist_json,
            status, created_at, updated_at FROM source_connections
     WHERE deployment_id = ? ORDER BY created_at DESC`,
  ).bind(env.DEPLOYMENT_ID).all();
  return json({ connections: rows.results.map((row) => ({ connectionId: row["connection_id"],
    providerId: row["provider_id"], accountLabel: row["account_label"],
    scopes: parseStoredJson(row["scopes_json"]), resourceIds: parseStoredJson(row["resource_allowlist_json"]),
    status: row["status"], createdAt: row["created_at"], updatedAt: row["updated_at"] })) });
};

const disconnect = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await bodyObject(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID || typeof body["connectionId"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const now = new Date().toISOString();
  await env.SOURCE_DB.batch([
    env.SOURCE_DB.prepare(
      "DELETE FROM source_encrypted_credentials WHERE deployment_id = ? AND connection_id = ?",
    ).bind(env.DEPLOYMENT_ID, body["connectionId"]),
    env.SOURCE_DB.prepare(
      `UPDATE source_connections SET status = 'revoked', updated_at = ?
       WHERE deployment_id = ? AND connection_id = ?`,
    ).bind(now, env.DEPLOYMENT_ID, body["connectionId"]),
  ]);
  return new Response(null, { status: 204 });
};

export default {
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/internal/v1/health") {
      return json({ service: "delegated-source-gatekeeper", status: "ok" });
    }
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;

export class DelegatedSourceAdminEntrypoint extends WorkerEntrypoint<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/internal/v1/health") {
      return json({ service: "delegated-source-gatekeeper", entrypoint: "admin", status: "ok" });
    }
    if (request.method === "POST" && path === "/internal/v1/oauth/start") return beginOAuth(request, this.env);
    if (request.method === "POST" && path === "/internal/v1/oauth/callback") return finishOAuth(request, this.env);
    if (request.method === "GET" && path === "/internal/v1/connections") return listConnections(request, this.env);
    if (request.method === "DELETE" && path === "/internal/v1/connections") return disconnect(request, this.env);
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}

export class DelegatedSourceReadEntrypoint extends WorkerEntrypoint<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/internal/v1/health") {
      return json({ service: "delegated-source-gatekeeper", entrypoint: "read", status: "ok" });
    }
    if (request.method === "POST" && path === "/internal/v1/read") return readSource(request, this.env);
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
