import { sha256Hex } from "@opap/security";
import { createRequestDigest, issueExecutionLease } from "@opap/approval";
import { importJWK, type JWK } from "jose";
import {
  DEFAULT_OWNER_MODEL_SETTINGS,
  cloudCostPolicySchema,
  delegatedSourceDefinitionSchema,
  delegatedSourceAclSchema,
  informationPolicySchema,
  modelProviderSettingSchema,
  normalizeTimeZone,
  ownerModelSettingsSchema,
  pluginManifestSchema,
  type ModelProviderSetting,
  type JsonValue,
} from "@opap/contracts";
import { evaluateDelegatedSourceAcl, type JwtClaims } from "@opap/identity";

type Bindings = {
  CONTROL_DB: D1Database;
  AUDIT_LEDGER: DurableObjectNamespace;
  EXECUTION_LEASE_PRIVATE_JWK: string;
};

type OwnerAuthenticationInput = {
  deploymentId: string;
  issuer: string;
  subject: string;
  email?: string;
  ownerEmail: string;
};

type PrincipalRow = {
  principal_id: string;
  issuer: string;
  subject_hash: string;
};

type DelegatedSourceRow = {
  source_id: string;
  source_type: string;
  resource_ids_json: string;
  acl_json: string;
  connection_id: string;
  source_version: number;
  information_policy_json: string;
  cache_enabled: number;
  cache_ttl_seconds: number;
};

type ApprovalRow = {
  approval_id: string;
  principal_id: string;
  capability_id: string;
  request_digest: string;
  preview_json: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decision_idempotency_key: string | null;
  request_json: string | null;
  task_id: string | null;
  gatekeeper_id: string | null;
  execution_status: string | null;
  execution_error_code: string | null;
  executed_at: string | null;
};

type ProviderSettingRow = {
  provider_id: "provider:mock-local" | "provider:workers-ai";
  enabled: number;
  allowed_information_json: string;
  last_idempotency_key: string | null;
  last_update_fingerprint: string | null;
  updated_at: string;
};

type ConversationRegistryInput = {
  deploymentId: string;
  conversationId: string;
  principalId: string;
  estimatedStorageBytes?: number;
  registrySource?: "runtime" | "discord-backfill" | "alpha-lazy-backfill";
};

const audit = async (
  env: Bindings,
  input: {
    deploymentId: string;
    principalId?: string;
    eventType: string;
    outcome: "success" | "denied" | "failure" | "unknown";
    requestId: string;
    metadata: Readonly<Record<string, unknown>>;
  },
): Promise<boolean> => {
  const stub = env.AUDIT_LEDGER.get(env.AUDIT_LEDGER.idFromName(input.deploymentId));
  const response = await stub.fetch("https://audit.internal/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventId: `audit:${crypto.randomUUID()}`,
      ...input,
      occurredAt: new Date().toISOString(),
    }),
  }).catch(() => undefined);
  return response?.ok === true;
};

const isOwnerInput = (value: unknown): value is OwnerAuthenticationInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["deploymentId", "issuer", "subject", "ownerEmail"].every(
    (key) => typeof input[key] === "string" && input[key].length > 0,
  ) && (input["email"] === undefined || typeof input["email"] === "string");
};

async function authenticateOwner(
  request: Request,
  database: D1Database,
): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (!isOwnerInput(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const subjectHash = await sha256Hex(`${value.issuer}\u0000${value.subject}`);
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT OR IGNORE INTO deployments (deployment_id, created_at) VALUES (?, ?)`,
  ).bind(value.deploymentId, now).run();
  await database.batch(DEFAULT_OWNER_MODEL_SETTINGS.providers.map((provider) =>
    database.prepare(
      `INSERT OR IGNORE INTO provider_settings
       (deployment_id, provider_id, enabled, allowed_information_json,
        soft_budget_micros, hard_budget_micros, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(
      value.deploymentId,
      provider.providerId,
      provider.enabled ? 1 : 0,
      JSON.stringify({
        allowedVisibilities: provider.allowedVisibilities,
        allowedSensitivities: provider.allowedSensitivities,
      }),
      now,
    )
  ));
  await database.prepare(
    `INSERT OR IGNORE INTO cloud_cost_policies
     (deployment_id, non_ai_mode, non_ai_fraction, ai_monthly_overage_micros,
      pricing_catalog_version, updated_at)
     VALUES (?, 'included-fraction', 0.8, 5000000, 'cloudflare-2026-08', ?)`,
  ).bind(value.deploymentId, now).run();
  let existing = await database.prepare(
    `SELECT principal_id, issuer, subject_hash FROM principals
     WHERE deployment_id = ? AND kind = 'owner' LIMIT 1`,
  ).bind(value.deploymentId).first<PrincipalRow>();
  if (!existing) {
    if (
      typeof value.email !== "string" ||
      value.email.toLowerCase() !== value.ownerEmail.toLowerCase()
    ) {
      return Response.json({ code: "OWNER_ACCESS_DENIED" }, { status: 403 });
    }
    await database.batch([
      database.prepare(
        `INSERT OR IGNORE INTO principals
         (deployment_id, principal_id, kind, issuer, subject_hash, created_at)
         VALUES (?, 'principal:owner', 'owner', ?, ?, ?)`,
      ).bind(value.deploymentId, value.issuer, subjectHash, now),
      database.prepare(
        `UPDATE deployments SET owner_bootstrapped_at = COALESCE(owner_bootstrapped_at, ?)
         WHERE deployment_id = ?`,
      ).bind(now, value.deploymentId),
    ]);
    existing = await database.prepare(
      `SELECT principal_id, issuer, subject_hash FROM principals
       WHERE deployment_id = ? AND kind = 'owner' LIMIT 1`,
    ).bind(value.deploymentId).first<PrincipalRow>();
  }
  if (
    !existing ||
    existing.issuer !== value.issuer ||
    existing.subject_hash !== subjectHash
  ) {
    return Response.json({ code: "OWNER_ACCESS_DENIED" }, { status: 403 });
  }
  return Response.json({ principalId: existing.principal_id });
}

const isClaims = (value: unknown): value is JwtClaims => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return typeof claims["iss"] === "string" &&
    typeof claims["sub"] === "string" &&
    typeof claims["exp"] === "number" &&
    (typeof claims["aud"] === "string" || Array.isArray(claims["aud"]));
};

async function authorizeDelegatedSource(
  request: Request,
  database: D1Database,
): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input["deploymentId"] !== "string" ||
    typeof input["sourceId"] !== "string" ||
    typeof input["principalId"] !== "string" ||
    !input["principalId"].startsWith("principal:delegated:") ||
    !isClaims(input["claims"])
  ) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const source = await database.prepare(
    `SELECT source_id, source_type, resource_ids_json, acl_json, connection_id,
            source_version, information_policy_json, cache_enabled, cache_ttl_seconds
     FROM delegated_sources
     WHERE deployment_id = ? AND source_id = ? AND enabled = 1`,
  ).bind(input["deploymentId"], input["sourceId"]).first<DelegatedSourceRow>();
  if (!source) {
    return Response.json({ code: "DELEGATED_ACL_DENIED" }, { status: 403 });
  }
  let aclValue: unknown;
  let resourceValue: unknown;
  let informationPolicyValue: unknown;
  try {
    aclValue = JSON.parse(source.acl_json) as unknown;
    resourceValue = JSON.parse(source.resource_ids_json) as unknown;
    informationPolicyValue = JSON.parse(source.information_policy_json) as unknown;
  } catch {
    return Response.json({ code: "SOURCE_CONFIGURATION_INVALID" }, { status: 503 });
  }
  const acl = delegatedSourceAclSchema.safeParse(aclValue);
  const informationPolicy = informationPolicySchema.safeParse(informationPolicyValue);
  if (
    !acl.success ||
    !informationPolicy.success ||
    !Array.isArray(resourceValue) ||
    resourceValue.length === 0 ||
    !resourceValue.every((resource) => typeof resource === "string") ||
    !evaluateDelegatedSourceAcl(acl.data, input["claims"])
  ) {
    return Response.json({ code: "DELEGATED_ACL_DENIED" }, { status: 403 });
  }
  return Response.json({
    sourceId: source.source_id,
    sourceType: source.source_type,
    resourceIds: resourceValue,
    connectionId: source.connection_id,
    sourceVersion: source.source_version,
    informationPolicy: {
      ...informationPolicy.data,
      deploymentId: input["deploymentId"],
      subjectPrincipalIds: [input["principalId"]],
      allowedAudienceIds: [input["principalId"]],
    },
    cachePolicy: {
      enabled: source.cache_enabled === 1,
      ttlSeconds: source.cache_ttl_seconds,
    },
  });
}

async function listAuthorizedDelegatedSources(request: Request, database: D1Database): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["principalId"] !== "string" ||
    !input["principalId"].startsWith("principal:delegated:") || !isClaims(input["claims"])) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const rows = await database.prepare(
    `SELECT source_id, source_type, acl_json FROM delegated_sources
     WHERE deployment_id = ? AND enabled = 1 ORDER BY source_id LIMIT 100`,
  ).bind(input["deploymentId"]).all<{ source_id: string; source_type: string; acl_json: string }>();
  const sources = rows.results.flatMap((source) => {
    try {
      const acl = delegatedSourceAclSchema.safeParse(JSON.parse(source.acl_json) as unknown);
      return acl.success && evaluateDelegatedSourceAcl(acl.data, input["claims"] as JwtClaims)
        ? [{ sourceId: source.source_id, kind: source.source_type }] : [];
    } catch { return []; }
  });
  return Response.json({ sources });
}

async function delegatedSources(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = request.method === "GET" ? url.searchParams.get("deploymentId") : undefined;
  if (request.method === "GET") {
    if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const result = await env.CONTROL_DB.prepare(
      `SELECT source_id, source_type, connection_id, resource_ids_json, acl_json,
              information_policy_json, cache_enabled, cache_ttl_seconds, source_version,
              enabled, created_at, updated_at
       FROM delegated_sources WHERE deployment_id = ? ORDER BY created_at DESC`,
    ).bind(deploymentId).all<Record<string, unknown>>();
    const parseJson = (input: unknown): unknown => JSON.parse(String(input)) as unknown;
    return Response.json({ sources: result.results.map((row) => ({
      sourceId: row["source_id"], sourceType: row["source_type"], connectionId: row["connection_id"],
      resourceIds: parseJson(row["resource_ids_json"]), acl: parseJson(row["acl_json"]),
      informationPolicy: parseJson(row["information_policy_json"]),
      cachePolicy: { enabled: row["cache_enabled"] === 1, ttlSeconds: row["cache_ttl_seconds"] },
      sourceVersion: row["source_version"], enabled: row["enabled"] === 1,
      createdAt: row["created_at"], updatedAt: row["updated_at"],
    })) });
  }
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  if (typeof body["deploymentId"] !== "string" || typeof body["principalId"] !== "string" ||
    typeof body["requestId"] !== "string" || typeof body["idempotencyKey"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const parsed = delegatedSourceDefinitionSchema.safeParse(body["source"]);
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST", errors: parsed.error.issues }, { status: 400 });
  const fingerprint = await sha256Hex(JSON.stringify(parsed.data));
  const existing = await env.CONTROL_DB.prepare(
    `SELECT source_id, source_type, connection_id, resource_ids_json, acl_json,
            information_policy_json, cache_enabled, cache_ttl_seconds, source_version, enabled,
            last_idempotency_key, last_update_fingerprint
     FROM delegated_sources WHERE deployment_id = ? AND source_id = ?`,
  ).bind(body["deploymentId"], parsed.data.sourceId).first<DelegatedSourceRow & {
    enabled: number; last_idempotency_key: string | null; last_update_fingerprint: string | null;
  }>();
  if (existing?.last_idempotency_key === body["idempotencyKey"]) {
    return existing.last_update_fingerprint === fingerprint
      ? Response.json({ ...parsed.data, sourceVersion: existing.source_version })
      : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  }
  const now = new Date().toISOString();
  const nextVersion = (existing?.source_version ?? 0) + 1;
  await env.CONTROL_DB.prepare(
    `INSERT INTO delegated_sources
     (deployment_id, source_id, source_type, resource_ids_json, acl_json, connection_id,
      enabled, created_at, updated_at, source_version, information_policy_json,
      cache_enabled, cache_ttl_seconds, last_idempotency_key, last_update_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deployment_id, source_id) DO UPDATE SET
       source_type = excluded.source_type, resource_ids_json = excluded.resource_ids_json,
       acl_json = excluded.acl_json, connection_id = excluded.connection_id,
       enabled = excluded.enabled, updated_at = excluded.updated_at,
       source_version = excluded.source_version,
       information_policy_json = excluded.information_policy_json,
       cache_enabled = excluded.cache_enabled, cache_ttl_seconds = excluded.cache_ttl_seconds,
       last_idempotency_key = excluded.last_idempotency_key,
       last_update_fingerprint = excluded.last_update_fingerprint`,
  ).bind(body["deploymentId"], parsed.data.sourceId, parsed.data.sourceType,
    JSON.stringify(parsed.data.resourceIds), JSON.stringify(parsed.data.acl), parsed.data.connectionId,
    parsed.data.enabled ? 1 : 0, now, now, nextVersion, JSON.stringify(parsed.data.informationPolicy),
    parsed.data.cachePolicy.enabled ? 1 : 0, parsed.data.cachePolicy.ttlSeconds,
    body["idempotencyKey"], fingerprint).run();
  const audited = await audit(env, { deploymentId: body["deploymentId"], principalId: body["principalId"],
    eventType: existing ? "delegated-source.updated" : "delegated-source.created", outcome: "success",
    requestId: body["requestId"], metadata: { sourceId: parsed.data.sourceId,
      sourceType: parsed.data.sourceType, sourceVersion: nextVersion } });
  if (!audited) {
    if (existing) {
      await env.CONTROL_DB.prepare(
        `UPDATE delegated_sources SET source_type = ?, connection_id = ?, resource_ids_json = ?,
         acl_json = ?, information_policy_json = ?, cache_enabled = ?, cache_ttl_seconds = ?,
         source_version = ?, enabled = ?, last_idempotency_key = ?, last_update_fingerprint = ?
         WHERE deployment_id = ? AND source_id = ?`,
      ).bind(existing.source_type, existing.connection_id, existing.resource_ids_json,
        existing.acl_json, existing.information_policy_json, existing.cache_enabled,
        existing.cache_ttl_seconds, existing.source_version, existing.enabled,
        existing.last_idempotency_key, existing.last_update_fingerprint,
        body["deploymentId"], parsed.data.sourceId).run();
    } else {
      await env.CONTROL_DB.prepare(
        "DELETE FROM delegated_sources WHERE deployment_id = ? AND source_id = ?",
      ).bind(body["deploymentId"], parsed.data.sourceId).run();
    }
    return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
  return Response.json({ ...parsed.data, sourceVersion: nextVersion }, { status: existing ? 200 : 201 });
}

async function deleteDelegatedSource(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  if (typeof body["deploymentId"] !== "string" || typeof body["sourceId"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["requestId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = await env.CONTROL_DB.prepare(
    `UPDATE delegated_sources SET enabled = 0, source_version = source_version + 1, updated_at = ?
     WHERE deployment_id = ? AND source_id = ? AND enabled = 1`,
  ).bind(new Date().toISOString(), body["deploymentId"], body["sourceId"]).run();
  if (result.meta.changes !== 1) return Response.json({ code: "SOURCE_NOT_FOUND" }, { status: 404 });
  const audited = await audit(env, { deploymentId: body["deploymentId"], principalId: body["principalId"],
    eventType: "delegated-source.deleted", outcome: "success", requestId: body["requestId"],
    metadata: { sourceId: body["sourceId"] } });
  if (!audited) {
    await env.CONTROL_DB.prepare(
      `UPDATE delegated_sources SET enabled = 1, source_version = MAX(1, source_version - 1)
       WHERE deployment_id = ? AND source_id = ?`,
    ).bind(body["deploymentId"], body["sourceId"]).run();
    return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}

const approvalJson = (row: ApprovalRow) => ({
  approvalId: row.approval_id,
  principalId: row.principal_id,
  capabilityId: row.capability_id,
  requestDigest: row.request_digest,
  preview: JSON.parse(row.preview_json) as unknown,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  ...(row.execution_status ? { executionStatus: row.execution_status } : {}),
  ...(row.execution_error_code ? { executionErrorCode: row.execution_error_code } : {}),
  ...(row.executed_at ? { executedAt: row.executed_at } : {}),
  ...(row.capability_id === "model.connector-results.send" && row.request_json
    ? { executionRequest: JSON.parse(row.request_json) as JsonValue }
    : {}),
});

async function listApprovals(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  const principalId = url.searchParams.get("principalId");
  if (!deploymentId || !principalId) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = await env.CONTROL_DB.prepare(
    `SELECT approval_id, principal_id, capability_id, request_digest, preview_json,
            status, created_at, expires_at, decided_at, decision_idempotency_key,
            request_json, task_id, gatekeeper_id, execution_status,
            execution_error_code, executed_at
     FROM approvals WHERE deployment_id = ? AND principal_id = ?
     ORDER BY created_at DESC LIMIT 100`,
  ).bind(deploymentId, principalId).all<ApprovalRow>();
  return Response.json({ approvals: result.results.map(approvalJson) });
}

async function createApproval(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input["deploymentId"] !== "string" ||
    typeof input["principalId"] !== "string" ||
    typeof input["capabilityId"] !== "string" ||
    typeof input["requestDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input["requestDigest"]) ||
    typeof input["preview"] !== "object" || input["preview"] === null ||
    typeof input["request"] !== "object" || input["request"] === null ||
    typeof input["taskId"] !== "string" ||
    (input["gatekeeperId"] !== "gatekeeper:google-personal" &&
      input["gatekeeperId"] !== "gatekeeper:github-personal" &&
      input["gatekeeperId"] !== "gatekeeper:model-router" &&
      input["gatekeeperId"] !== "gatekeeper:discord" &&
      input["gatekeeperId"] !== "gatekeeper:plugin-control") ||
    typeof input["requestId"] !== "string"
    || typeof input["idempotencyKey"] !== "string"
  ) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  if (input["capabilityId"] !== "google.gmail.drafts.create" &&
    input["capabilityId"] !== "google.gmail.messages.send" &&
    input["capabilityId"] !== "google.calendar.events.create" &&
    input["capabilityId"] !== "github.issues.create" &&
    input["capabilityId"] !== "github.issue-comments.create" &&
    input["capabilityId"] !== "model.connector-results.send" &&
    input["capabilityId"] !== "discord.notification-destinations.configure" &&
    input["capabilityId"] !== "discord.notification-policy.update" &&
    input["capabilityId"] !== "discord.notifications.deliver" &&
    input["capabilityId"] !== "plugin.capabilities.grant") {
    return Response.json({ code: "CAPABILITY_NOT_ALLOWED" }, { status: 403 });
  }
  const expectedGatekeeper = String(input["capabilityId"]).startsWith("github.")
    ? "gatekeeper:github-personal"
    : input["capabilityId"] === "plugin.capabilities.grant"
      ? "gatekeeper:plugin-control"
    : String(input["capabilityId"]).startsWith("discord.")
      ? "gatekeeper:discord"
    : input["capabilityId"] === "model.connector-results.send"
      ? "gatekeeper:model-router" : "gatekeeper:google-personal";
  if (input["gatekeeperId"] !== expectedGatekeeper) {
    return Response.json({ code: "GATEKEEPER_CAPABILITY_MISMATCH" }, { status: 403 });
  }
  const operationRequest = input["request"] as JsonValue;
  if (await createRequestDigest(operationRequest) !== input["requestDigest"]) {
    return Response.json({ code: "REQUEST_DIGEST_MISMATCH" }, { status: 409 });
  }
  const now = new Date();
  const approvalId = `approval:${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO approvals
     (deployment_id, approval_id, principal_id, capability_id, request_digest,
      preview_json, status, created_at, expires_at, request_json, task_id, gatekeeper_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).bind(
    input["deploymentId"], approvalId, input["principalId"], input["capabilityId"],
    input["requestDigest"], JSON.stringify(input["preview"]), now.toISOString(), expiresAt,
    JSON.stringify(operationRequest), input["taskId"], input["gatekeeperId"],
  ).run();
  const audited = await audit(env, {
    deploymentId: input["deploymentId"],
    principalId: input["principalId"],
    eventType: "approval.created",
    outcome: "success",
    requestId: input["requestId"],
    metadata: { approvalId, capabilityId: input["capabilityId"] },
  });
  if (!audited) return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  return Response.json({
    approvalId,
    principalId: input["principalId"],
    capabilityId: input["capabilityId"],
    requestDigest: input["requestDigest"],
    preview: input["preview"],
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt,
  }, { status: 201 });
}

type DiscordOwnerLinkRow = {
  owner_principal_id: string;
  discord_user_id: string;
  discord_display_name: string | null;
  conversation_id: string;
  status: "active" | "revoked";
  dm_notifications_enabled: number;
  linked_at: string;
  updated_at: string;
  revoked_at: string | null;
};

const discordLinkJson = (row: DiscordOwnerLinkRow) => ({
  ownerPrincipalId: row.owner_principal_id,
  discordUserId: row.discord_user_id,
  displayName: row.discord_display_name,
  conversationId: row.conversation_id,
  status: row.status,
  dmNotificationsEnabled: row.dm_notifications_enabled === 1,
  linkedAt: row.linked_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at,
});

async function createDiscordLinkCode(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" ||
    typeof input["principalId"] !== "string" ||
    typeof input["conversationId"] !== "string" ||
    typeof input["codeDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(input["codeDigest"]) ||
    typeof input["expiresAt"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `DELETE FROM discord_link_codes
       WHERE deployment_id = ? AND owner_principal_id = ? AND consumed_at IS NULL`,
    ).bind(input["deploymentId"], input["principalId"]),
    env.CONTROL_DB.prepare(
      `INSERT INTO discord_link_codes
       (deployment_id, code_digest, owner_principal_id, conversation_id,
        expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(input["deploymentId"], input["codeDigest"], input["principalId"],
      input["conversationId"], input["expiresAt"], now),
  ]);
  await audit(env, { deploymentId: input["deploymentId"], principalId: input["principalId"],
    eventType: "discord.link-code.created", outcome: "success",
    requestId: crypto.randomUUID(), metadata: { expiresAt: input["expiresAt"] } });
  return Response.json({ expiresAt: input["expiresAt"] }, { status: 201 });
}

async function consumeDiscordLinkCode(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["codeDigest"] !== "string" ||
    typeof input["discordUserId"] !== "string" ||
    (input["displayName"] !== undefined && typeof input["displayName"] !== "string")) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const row = await env.CONTROL_DB.prepare(
    `SELECT owner_principal_id, conversation_id, expires_at, consumed_at
     FROM discord_link_codes WHERE deployment_id = ? AND code_digest = ?`,
  ).bind(input["deploymentId"], input["codeDigest"]).first<{
    owner_principal_id: string; conversation_id: string; expires_at: string; consumed_at: string | null;
  }>();
  const now = new Date();
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now.getTime()) {
    return Response.json({ code: "DISCORD_LINK_CODE_INVALID" }, { status: 409 });
  }
  const conflictingOwner = await env.CONTROL_DB.prepare(
    `SELECT discord_user_id FROM discord_owner_links
     WHERE deployment_id = ? AND owner_principal_id = ? AND status = 'active'`,
  ).bind(input["deploymentId"], row.owner_principal_id).first<{ discord_user_id: string }>();
  if (conflictingOwner && conflictingOwner.discord_user_id !== input["discordUserId"]) {
    return Response.json({ code: "DISCORD_OTHER_USER_ALREADY_LINKED" }, { status: 409 });
  }
  const conflictingUser = await env.CONTROL_DB.prepare(
    `SELECT owner_principal_id FROM discord_owner_links
     WHERE deployment_id = ? AND discord_user_id = ? AND status = 'active'`,
  ).bind(input["deploymentId"], input["discordUserId"]).first<{ owner_principal_id: string }>();
  if (conflictingUser && conflictingUser.owner_principal_id !== row.owner_principal_id) {
    return Response.json({ code: "DISCORD_USER_ALREADY_LINKED" }, { status: 409 });
  }
  const consumedAt = now.toISOString();
  const consumed = await env.CONTROL_DB.prepare(
    `UPDATE discord_link_codes SET consumed_at = ?
     WHERE deployment_id = ? AND code_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(consumedAt, input["deploymentId"], input["codeDigest"], consumedAt).run();
  if (consumed.meta.changes !== 1) {
    return Response.json({ code: "DISCORD_LINK_CODE_REPLAY" }, { status: 409 });
  }
  await env.CONTROL_DB.prepare(
    `INSERT INTO discord_owner_links
     (deployment_id, owner_principal_id, discord_user_id, discord_display_name,
      conversation_id, status, dm_notifications_enabled, linked_at, updated_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)
     ON CONFLICT (deployment_id, owner_principal_id) DO UPDATE SET
       discord_user_id = excluded.discord_user_id,
       discord_display_name = excluded.discord_display_name,
       conversation_id = excluded.conversation_id,
       status = 'active', dm_notifications_enabled = 1,
       updated_at = excluded.updated_at, revoked_at = NULL`,
  ).bind(input["deploymentId"], row.owner_principal_id, input["discordUserId"],
    input["displayName"] ?? null, row.conversation_id, consumedAt, consumedAt).run();
  await audit(env, { deploymentId: input["deploymentId"], principalId: row.owner_principal_id,
    eventType: "discord.linked", outcome: "success", requestId: crypto.randomUUID(),
    metadata: { discordUserId: input["discordUserId"] } });
  return Response.json({ ownerPrincipalId: row.owner_principal_id,
    conversationId: row.conversation_id, linkedAt: consumedAt });
}

async function getDiscordLink(request: Request, env: Bindings, resolveByUser: boolean): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  const identity = url.searchParams.get(resolveByUser ? "discordUserId" : "principalId");
  if (!deploymentId || !identity) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const field = resolveByUser ? "discord_user_id" : "owner_principal_id";
  const row = await env.CONTROL_DB.prepare(
    `SELECT owner_principal_id, discord_user_id, discord_display_name, conversation_id,
            status, dm_notifications_enabled, linked_at, updated_at, revoked_at
     FROM discord_owner_links WHERE deployment_id = ? AND ${field} = ? AND status = 'active'`,
  ).bind(deploymentId, identity).first<DiscordOwnerLinkRow>();
  return row ? Response.json({ link: discordLinkJson(row) })
    : Response.json({ code: "DISCORD_LINK_NOT_FOUND" }, { status: 404 });
}

async function revokeDiscordLink(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["principalId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `UPDATE discord_owner_links SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE deployment_id = ? AND owner_principal_id = ? AND status = 'active'`,
  ).bind(now, now, input["deploymentId"], input["principalId"]).run();
  await audit(env, { deploymentId: input["deploymentId"], principalId: input["principalId"],
    eventType: "discord.unlinked", outcome: "success", requestId: crypto.randomUUID(), metadata: {} });
  return new Response(null, { status: 204 });
}

async function decideApproval(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input["deploymentId"] !== "string" ||
    typeof input["principalId"] !== "string" ||
    typeof input["approvalId"] !== "string" ||
    (input["decision"] !== "approved" && input["decision"] !== "rejected") ||
    typeof input["requestId"] !== "string"
  ) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const current = await env.CONTROL_DB.prepare(
    `SELECT approval_id, principal_id, capability_id, request_digest, preview_json,
            status, created_at, expires_at, decided_at, decision_idempotency_key,
            request_json, task_id, gatekeeper_id, execution_status,
            execution_error_code, executed_at
     FROM approvals WHERE deployment_id = ? AND approval_id = ? AND principal_id = ?`,
  ).bind(input["deploymentId"], input["approvalId"], input["principalId"]).first<ApprovalRow>();
  if (!current) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  if (
    current.status === input["decision"] &&
    current.decision_idempotency_key === input["idempotencyKey"]
  ) {
    const replay = approvalJson(current);
    return Response.json(current.capability_id === "model.connector-results.send" && current.request_json
      ? { ...replay, executionRequest: JSON.parse(current.request_json) as JsonValue }
      : replay);
  }
  if (current.status !== "pending" || Date.parse(current.expires_at) <= Date.now()) {
    return Response.json({ code: "APPROVAL_NOT_PENDING" }, { status: 409 });
  }
  const now = new Date().toISOString();
  const result = await env.CONTROL_DB.prepare(
    `UPDATE approvals SET status = ?, decided_at = ?, decision_idempotency_key = ?,
       execution_status = ?
     WHERE deployment_id = ? AND approval_id = ? AND principal_id = ? AND status = 'pending'`,
  ).bind(
    input["decision"], now, input["idempotencyKey"],
    input["decision"] === "approved" ? "pending" : null, input["deploymentId"],
    input["approvalId"], input["principalId"],
  ).run();
  if (result.meta.changes !== 1) {
    return Response.json({ code: "APPROVAL_NOT_PENDING" }, { status: 409 });
  }
  const audited = await audit(env, {
    deploymentId: input["deploymentId"],
    principalId: input["principalId"],
    eventType: "approval.decided",
    outcome: "success",
    requestId: input["requestId"],
    metadata: { approvalId: input["approvalId"], decision: input["decision"] },
  });
  if (!audited) return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  const decided = approvalJson({
    ...current,
    status: input["decision"],
    decided_at: now,
    decision_idempotency_key: String(input["idempotencyKey"]),
    execution_status: input["decision"] === "approved" ? "pending" : null,
  });
  if (input["decision"] !== "approved") {
    return Response.json(current.capability_id === "model.connector-results.send" && current.request_json
      ? { ...decided, executionRequest: JSON.parse(current.request_json) as JsonValue }
      : decided);
  }
  if (current.capability_id === "plugin.capabilities.grant") {
    if (!current.request_json) {
      return Response.json({ code: "APPROVAL_EXECUTION_DATA_MISSING" }, { status: 503 });
    }
    const pluginRequest = JSON.parse(current.request_json) as Record<string, unknown>;
    if (typeof pluginRequest["installationId"] !== "string" ||
      typeof pluginRequest["versionId"] !== "string") {
      return Response.json({ code: "APPROVAL_EXECUTION_DATA_INVALID" }, { status: 503 });
    }
    const version = await env.CONTROL_DB.prepare(
      `SELECT manifest_json, plugin_version, archive_sha256, requested_capability_ids_json
       FROM plugin_versions WHERE deployment_id = ? AND installation_id = ? AND version_id = ?
         AND status = 'pending-approval'`,
    ).bind(input["deploymentId"], pluginRequest["installationId"],
      pluginRequest["versionId"]).first<{ manifest_json: string; plugin_version: string;
        archive_sha256: string; requested_capability_ids_json: string }>();
    if (!version) return Response.json({ code: "PLUGIN_VERSION_NOT_PENDING" }, { status: 409 });
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE plugin_versions SET status = 'superseded'
         WHERE deployment_id = ? AND installation_id = ? AND status = 'active'`,
      ).bind(input["deploymentId"], pluginRequest["installationId"]),
      env.CONTROL_DB.prepare(
        `UPDATE plugin_versions SET status = 'active', activated_at = ?
         WHERE deployment_id = ? AND version_id = ?`,
      ).bind(now, input["deploymentId"], pluginRequest["versionId"]),
      env.CONTROL_DB.prepare(
        `UPDATE plugin_installations SET plugin_version = ?, artifact_sha256 = ?, manifest_json = ?,
           granted_capability_ids_json = ?, active_version_id = ?, status = 'active', updated_at = ?
         WHERE deployment_id = ? AND installation_id = ? AND status != 'removed'`,
      ).bind(version.plugin_version, version.archive_sha256, version.manifest_json,
        version.requested_capability_ids_json, pluginRequest["versionId"], now,
        input["deploymentId"], pluginRequest["installationId"]),
      env.CONTROL_DB.prepare(
        `UPDATE approvals SET execution_status = 'succeeded', executed_at = ?
         WHERE deployment_id = ? AND approval_id = ?`,
      ).bind(now, input["deploymentId"], current.approval_id),
    ]);
    return Response.json({ ...decided, executionStatus: "succeeded",
      installationId: pluginRequest["installationId"], versionId: pluginRequest["versionId"] });
  }
  if (!current.request_json || !current.task_id || !current.gatekeeper_id) {
    return Response.json({ code: "APPROVAL_EXECUTION_DATA_MISSING" }, { status: 503 });
  }
  const requestValue = JSON.parse(current.request_json) as JsonValue;
  const keyValue: unknown = JSON.parse(env.EXECUTION_LEASE_PRIVATE_JWK);
  if (typeof keyValue !== "object" || keyValue === null || Array.isArray(keyValue)) {
    return Response.json({ code: "LEASE_KEY_INVALID" }, { status: 503 });
  }
  const privateKey = await importJWK(keyValue as JWK, "EdDSA");
  const executionLease = await issueExecutionLease({
    issuer: `control:${input["deploymentId"]}`,
    principalId: input["principalId"],
    capabilityId: current.capability_id,
    gatekeeperId: current.gatekeeper_id,
    taskId: current.task_id,
    request: requestValue,
    grantVersion: 1,
    policyVersion: 1,
    approvalId: current.approval_id,
  }, privateKey);
  return Response.json({ ...decided, executionLease, executionRequest: requestValue });
}

async function recordApprovalExecution(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["principalId"] !== "string" ||
    typeof input["approvalId"] !== "string" ||
    (input["executionStatus"] !== "succeeded" && input["executionStatus"] !== "failed" &&
      input["executionStatus"] !== "unknown") || typeof input["requestId"] !== "string" ||
    (input["errorCode"] !== undefined && typeof input["errorCode"] !== "string")) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const updated = await env.CONTROL_DB.prepare(
    `UPDATE approvals SET execution_status = ?, execution_error_code = ?, executed_at = ?
     WHERE deployment_id = ? AND approval_id = ? AND principal_id = ? AND status = 'approved'
       AND execution_status = 'pending'`,
  ).bind(input["executionStatus"], input["errorCode"] ?? null, now,
    input["deploymentId"], input["approvalId"], input["principalId"]).run();
  if (updated.meta.changes !== 1) {
    return Response.json({ code: "APPROVAL_EXECUTION_NOT_PENDING" }, { status: 409 });
  }
  const audited = await audit(env, {
    deploymentId: input["deploymentId"], principalId: input["principalId"],
    eventType: "approval.execution.completed",
    outcome: input["executionStatus"] === "succeeded" ? "success" :
      input["executionStatus"] === "unknown" ? "unknown" : "failure",
    requestId: input["requestId"],
    metadata: { approvalId: input["approvalId"], executionStatus: input["executionStatus"],
      ...(typeof input["errorCode"] === "string" ? { errorCode: input["errorCode"] } : {}) },
  });
  return audited
    ? Response.json({ executionStatus: input["executionStatus"], executedAt: now })
    : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

async function reconcileApprovalExecution(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["principalId"] !== "string" ||
    typeof input["approvalId"] !== "string" ||
    (input["executionStatus"] !== "succeeded" && input["executionStatus"] !== "failed") ||
    typeof input["requestId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const updated = await env.CONTROL_DB.prepare(
    `UPDATE approvals SET execution_status = ?, execution_error_code = ?, executed_at = ?
     WHERE deployment_id = ? AND approval_id = ? AND principal_id = ? AND status = 'approved'
       AND execution_status = 'unknown'`,
  ).bind(input["executionStatus"], input["executionStatus"] === "failed"
    ? "OWNER_CONFIRMED_NOT_EXECUTED" : null, now, input["deploymentId"],
    input["approvalId"], input["principalId"]).run();
  if (updated.meta.changes !== 1) {
    return Response.json({ code: "APPROVAL_EXECUTION_NOT_UNKNOWN" }, { status: 409 });
  }
  const audited = await audit(env, {
    deploymentId: input["deploymentId"], principalId: input["principalId"],
    eventType: "approval.execution.reconciled",
    outcome: input["executionStatus"] === "succeeded" ? "success" : "failure",
    requestId: input["requestId"],
    metadata: { approvalId: input["approvalId"], executionStatus: input["executionStatus"],
      source: "owner-external-verification" },
  });
  return audited
    ? Response.json({ executionStatus: input["executionStatus"], reconciledAt: now })
    : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

async function listAudit(request: Request, env: Bindings): Promise<Response> {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const stub = env.AUDIT_LEDGER.get(env.AUDIT_LEDGER.idFromName(deploymentId));
  return stub.fetch("https://audit.internal/events");
}

async function budgetSettings(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  if (request.method === "GET") {
    const row = await env.CONTROL_DB.prepare(
      `SELECT non_ai_mode, non_ai_fraction, ai_monthly_overage_micros,
              pricing_catalog_version FROM cloud_cost_policies WHERE deployment_id = ?`,
    ).bind(deploymentId).first<{
      non_ai_mode: "included-fraction" | "unlimited";
      non_ai_fraction: number | null;
      ai_monthly_overage_micros: number | null;
      pricing_catalog_version: string;
    }>();
    if (!row) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    return Response.json({
      nonAi: row.non_ai_mode === "unlimited"
        ? { mode: "unlimited" }
        : { mode: "included-fraction", fraction: row.non_ai_fraction },
      ai: {
        monthlyOverageUsd: row.ai_monthly_overage_micros === null
          ? null
          : row.ai_monthly_overage_micros / 1_000_000,
      },
      pricingCatalogVersion: row.pricing_catalog_version,
    });
  }
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const policy = cloudCostPolicySchema.safeParse(body["policy"]);
  if (!policy.success || typeof body["idempotencyKey"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["requestId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const fingerprint = await sha256Hex(JSON.stringify(policy.data));
  const current = await env.CONTROL_DB.prepare(
    `SELECT last_idempotency_key, last_update_fingerprint FROM cloud_cost_policies
     WHERE deployment_id = ?`,
  ).bind(deploymentId).first<{
    last_idempotency_key: string | null;
    last_update_fingerprint: string | null;
  }>();
  if (current?.last_idempotency_key === body["idempotencyKey"]) {
    return current.last_update_fingerprint === fingerprint
      ? Response.json(policy.data)
      : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `UPDATE cloud_cost_policies SET non_ai_mode = ?, non_ai_fraction = ?,
       ai_monthly_overage_micros = ?, pricing_catalog_version = ?, updated_at = ?,
       last_idempotency_key = ?, last_update_fingerprint = ?
     WHERE deployment_id = ?`,
  ).bind(
    policy.data.nonAi.mode,
    policy.data.nonAi.mode === "included-fraction" ? policy.data.nonAi.fraction : null,
    policy.data.ai.monthlyOverageUsd === null
      ? null
      : Math.round(policy.data.ai.monthlyOverageUsd * 1_000_000),
    policy.data.pricingCatalogVersion,
    now,
    body["idempotencyKey"],
    fingerprint,
    deploymentId,
  ).run();
  const audited = await audit(env, {
    deploymentId,
    principalId: String(body["principalId"]),
    eventType: "budget.changed",
    outcome: "success",
    requestId: String(body["requestId"]),
    metadata: { pricingCatalogVersion: policy.data.pricingCatalogVersion },
  });
  return audited
    ? Response.json(policy.data)
    : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

const providerSettingJson = (row: ProviderSettingRow): ModelProviderSetting | undefined => {
  let policy: unknown;
  try {
    policy = JSON.parse(row.allowed_information_json) as unknown;
  } catch {
    return undefined;
  }
  const parsed = modelProviderSettingSchema.safeParse({
    providerId: row.provider_id,
    enabled: row.enabled === 1,
    ...(typeof policy === "object" && policy !== null ? policy : {}),
  });
  return parsed.success ? parsed.data : undefined;
};

async function providerSettings(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  if (request.method === "GET") {
    const rows = await env.CONTROL_DB.prepare(
      `SELECT provider_id, enabled, allowed_information_json,
              last_idempotency_key, last_update_fingerprint
       FROM provider_settings WHERE deployment_id = ? ORDER BY provider_id`,
    ).bind(deploymentId).all<ProviderSettingRow>();
    const providers = rows.results.map(providerSettingJson);
    const parsed = ownerModelSettingsSchema.safeParse({ providers });
    return parsed.success
      ? Response.json(parsed.data)
      : Response.json({ code: "PROVIDER_CONFIGURATION_INVALID" }, { status: 503 });
  }
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const settings = ownerModelSettingsSchema.safeParse(body["settings"]);
  if (!settings.success || typeof body["idempotencyKey"] !== "string" ||
    typeof body["principalId"] !== "string" || typeof body["requestId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const fingerprint = await sha256Hex(JSON.stringify(settings.data));
  const previous = await env.CONTROL_DB.prepare(
    `SELECT provider_id, enabled, allowed_information_json,
            last_idempotency_key, last_update_fingerprint, updated_at
     FROM provider_settings WHERE deployment_id = ? ORDER BY provider_id`,
  ).bind(deploymentId).all<ProviderSettingRow>();
  const current = previous.results[0];
  if (current?.last_idempotency_key === body["idempotencyKey"]) {
    return current.last_update_fingerprint === fingerprint
      ? Response.json(settings.data)
      : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.batch(settings.data.providers.map((provider) =>
    env.CONTROL_DB.prepare(
      `INSERT INTO provider_settings
       (deployment_id, provider_id, enabled, allowed_information_json,
        soft_budget_micros, hard_budget_micros, last_idempotency_key,
        last_update_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
       ON CONFLICT(deployment_id, provider_id) DO UPDATE SET
         enabled = excluded.enabled,
         allowed_information_json = excluded.allowed_information_json,
         last_idempotency_key = excluded.last_idempotency_key,
         last_update_fingerprint = excluded.last_update_fingerprint,
         updated_at = excluded.updated_at`,
    ).bind(
      deploymentId, provider.providerId, provider.enabled ? 1 : 0,
      JSON.stringify({
        allowedVisibilities: provider.allowedVisibilities,
        allowedSensitivities: provider.allowedSensitivities,
      }),
      body["idempotencyKey"], fingerprint, now,
    )
  ));
  const audited = await audit(env, {
    deploymentId,
    principalId: String(body["principalId"]),
    eventType: "provider.settings.changed",
    outcome: "success",
    requestId: String(body["requestId"]),
    metadata: {
      activeProviderId: settings.data.providers.find((provider) => provider.enabled)?.providerId,
    },
  });
  if (!audited) {
    const previousByProvider = new Map(previous.results.map((row) => [row.provider_id, row]));
    await env.CONTROL_DB.batch(settings.data.providers.map((provider) => {
      const row = previousByProvider.get(provider.providerId);
      return row
        ? env.CONTROL_DB.prepare(
            `UPDATE provider_settings SET enabled = ?, allowed_information_json = ?,
               last_idempotency_key = ?, last_update_fingerprint = ?, updated_at = ?
             WHERE deployment_id = ? AND provider_id = ?
               AND last_idempotency_key = ? AND last_update_fingerprint = ?`,
          ).bind(
            row.enabled, row.allowed_information_json, row.last_idempotency_key,
            row.last_update_fingerprint, row.updated_at, deploymentId, provider.providerId,
            body["idempotencyKey"], fingerprint,
          )
        : env.CONTROL_DB.prepare(
            `DELETE FROM provider_settings
             WHERE deployment_id = ? AND provider_id = ?
               AND last_idempotency_key = ? AND last_update_fingerprint = ?`,
          ).bind(deploymentId, provider.providerId, body["idempotencyKey"], fingerprint);
    }));
    return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
  return Response.json(settings.data);
}

async function ownerPreferences(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const current = await env.CONTROL_DB.prepare(
    `SELECT time_zone, last_idempotency_key, last_update_fingerprint, updated_at
     FROM owner_preferences WHERE deployment_id = ?`,
  ).bind(deploymentId).first<{ time_zone: string; last_idempotency_key: string | null;
    last_update_fingerprint: string | null; updated_at: string }>();
  if (request.method === "GET") {
    return current ? Response.json({ timeZone: current.time_zone, updatedAt: current.updated_at })
      : Response.json({ code: "OWNER_PREFERENCES_NOT_SET" }, { status: 404 });
  }
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const timeZone = normalizeTimeZone(body["timeZone"]);
  if (!timeZone || typeof body["principalId"] !== "string" ||
    typeof body["requestId"] !== "string" || typeof body["idempotencyKey"] !== "string") {
    return Response.json({ code: "INVALID_TIME_ZONE" }, { status: 400 });
  }
  const fingerprint = await sha256Hex(timeZone);
  if (current?.last_idempotency_key === body["idempotencyKey"]) {
    return current.last_update_fingerprint === fingerprint
      ? Response.json({ timeZone: current.time_zone, updatedAt: current.updated_at })
      : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO owner_preferences
     (deployment_id, time_zone, last_idempotency_key, last_update_fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(deployment_id) DO UPDATE SET time_zone = excluded.time_zone,
       last_idempotency_key = excluded.last_idempotency_key,
       last_update_fingerprint = excluded.last_update_fingerprint,
       updated_at = excluded.updated_at`,
  ).bind(deploymentId, timeZone, body["idempotencyKey"], fingerprint, now).run();
  const audited = await audit(env, { deploymentId, principalId: body["principalId"],
    eventType: "owner.time-zone.changed", outcome: "success", requestId: body["requestId"],
    metadata: { timeZone },
  });
  if (!audited) {
    if (current) {
      await env.CONTROL_DB.prepare(
        `UPDATE owner_preferences SET time_zone = ?, last_idempotency_key = ?,
         last_update_fingerprint = ?, updated_at = ? WHERE deployment_id = ?`,
      ).bind(current.time_zone, current.last_idempotency_key, current.last_update_fingerprint,
        current.updated_at, deploymentId).run();
    } else {
      await env.CONTROL_DB.prepare("DELETE FROM owner_preferences WHERE deployment_id = ?")
        .bind(deploymentId).run();
    }
    return Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
  return Response.json({ timeZone, updatedAt: now });
}

const isConversationRegistryInput = (value: unknown): value is ConversationRegistryInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["deploymentId"] === "string" &&
    typeof input["conversationId"] === "string" &&
    /^conversation:[a-f0-9]{64}$/u.test(input["conversationId"]) &&
    typeof input["principalId"] === "string" &&
    (input["estimatedStorageBytes"] === undefined ||
      (typeof input["estimatedStorageBytes"] === "number" &&
        Number.isSafeInteger(input["estimatedStorageBytes"]) && input["estimatedStorageBytes"] >= 0)) &&
    (input["registrySource"] === undefined || input["registrySource"] === "runtime" ||
      input["registrySource"] === "discord-backfill" ||
      input["registrySource"] === "alpha-lazy-backfill");
};

async function conversationRegistry(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const deploymentId = url.searchParams.get("deploymentId");
    if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const rows = await env.CONTROL_DB.prepare(
      `SELECT conversation_id, owner_principal_id, created_at, last_used_at,
              estimated_storage_bytes, deleted_at, registry_source
       FROM conversation_registry WHERE deployment_id = ?
       ORDER BY last_used_at DESC LIMIT 1000`,
    ).bind(deploymentId).all<{
      conversation_id: string; owner_principal_id: string; created_at: string; last_used_at: string;
      estimated_storage_bytes: number; deleted_at: string | null; registry_source: string;
    }>();
    return Response.json({ conversations: rows.results.map((row) => ({
      conversationId: row.conversation_id,
      principalId: row.owner_principal_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      estimatedStorageBytes: row.estimated_storage_bytes,
      deletedAt: row.deleted_at,
      registrySource: row.registry_source,
    })) });
  }
  const value: unknown = await request.json().catch(() => null);
  if (!isConversationRegistryInput(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    const updated = await env.CONTROL_DB.prepare(
      `UPDATE conversation_registry SET deleted_at = COALESCE(deleted_at, ?), last_used_at = ?
       WHERE deployment_id = ? AND conversation_id = ? AND owner_principal_id = ?`,
    ).bind(now, now, value.deploymentId, value.conversationId, value.principalId).run();
    return updated.meta.changes === 1
      ? Response.json({ conversationId: value.conversationId, deletedAt: now })
      : Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  await env.CONTROL_DB.prepare(
    `INSERT INTO conversation_registry
     (deployment_id, conversation_id, owner_principal_id, created_at, last_used_at,
      estimated_storage_bytes, deleted_at, registry_source)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(deployment_id, conversation_id) DO UPDATE SET
       last_used_at = excluded.last_used_at,
       estimated_storage_bytes = MAX(conversation_registry.estimated_storage_bytes,
                                     excluded.estimated_storage_bytes),
       registry_source = CASE WHEN conversation_registry.registry_source = 'runtime'
         THEN conversation_registry.registry_source ELSE excluded.registry_source END`,
  ).bind(value.deploymentId, value.conversationId, value.principalId, now, now,
    value.estimatedStorageBytes ?? 0, value.registrySource ?? "runtime").run();
  return Response.json({ conversationId: value.conversationId, registeredAt: now }, { status: 201 });
}

async function conversationStorageStatus(request: Request, env: Bindings): Promise<Response> {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const row = await env.CONTROL_DB.prepare(
    `SELECT COALESCE(SUM(estimated_storage_bytes), 0) AS used_bytes
     FROM conversation_registry WHERE deployment_id = ? AND deleted_at IS NULL`,
  ).bind(deploymentId).first<{ used_bytes: number }>();
  const usedBytes = Number(row?.used_bytes ?? 0);
  const hardLimitBytes = 4 * 1024 * 1024 * 1024;
  return Response.json({ resource: "durable-object-sqlite", usedBytes, hardLimitBytes,
    hardLimitReached: usedBytes >= hardLimitBytes });
}

const pluginMutationInput = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return typeof input["deploymentId"] === "string" && typeof input["principalId"] === "string" &&
    typeof input["requestId"] === "string" && typeof input["idempotencyKey"] === "string"
    ? input : undefined;
};

async function listPlugins(request: Request, env: Bindings): Promise<Response> {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const rows = await env.CONTROL_DB.prepare(
    `SELECT i.installation_id, i.plugin_id, i.plugin_version, i.artifact_sha256,
            i.manifest_json, i.granted_capability_ids_json, i.status, i.active_version_id,
            i.created_at, i.updated_at, i.removed_at
     FROM plugin_installations i WHERE i.deployment_id = ? ORDER BY i.created_at DESC`,
  ).bind(deploymentId).all<{
    installation_id: string; plugin_id: string; plugin_version: string; artifact_sha256: string;
    manifest_json: string; granted_capability_ids_json: string; status: string;
    active_version_id: string | null; created_at: string; updated_at: string; removed_at: string | null;
  }>();
  const versions = await env.CONTROL_DB.prepare(
    `SELECT version_id, installation_id, plugin_version, archive_sha256,
            requested_capability_ids_json, status, created_at, activated_at
     FROM plugin_versions WHERE deployment_id = ? ORDER BY created_at DESC`,
  ).bind(deploymentId).all<{ version_id: string; installation_id: string; plugin_version: string;
    archive_sha256: string; requested_capability_ids_json: string; status: string;
    created_at: string; activated_at: string | null }>();
  return Response.json({ plugins: rows.results.map((row) => ({
    installationId: row.installation_id, pluginId: row.plugin_id, version: row.plugin_version,
    archiveSha256: row.artifact_sha256, manifest: JSON.parse(row.manifest_json) as unknown,
    grantedCapabilityIds: JSON.parse(row.granted_capability_ids_json) as unknown,
    status: row.status, activeVersionId: row.active_version_id, createdAt: row.created_at,
    updatedAt: row.updated_at, removedAt: row.removed_at,
    versions: versions.results.filter((version) => version.installation_id === row.installation_id)
      .map((version) => ({ versionId: version.version_id, version: version.plugin_version,
        archiveSha256: version.archive_sha256,
        requestedCapabilityIds: JSON.parse(version.requested_capability_ids_json) as unknown,
        status: version.status, createdAt: version.created_at, activatedAt: version.activated_at })),
  })) });
}

async function recordPluginInspection(request: Request, env: Bindings): Promise<Response> {
  const input = await pluginMutationInput(request);
  const inspection = input?.["inspection"];
  if (!input || typeof inspection !== "object" || inspection === null || Array.isArray(inspection)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const row = inspection as Record<string, unknown>;
  const manifest = pluginManifestSchema.safeParse(row["manifest"]);
  if (!manifest.success || typeof row["archiveSha256"] !== "string" ||
    typeof row["bundleSha256"] !== "string" || typeof row["r2ObjectKey"] !== "string" ||
    typeof row["expandedBytes"] !== "number" || typeof row["entryCount"] !== "number" ||
    (row["sbomVersion"] !== "1.5" && row["sbomVersion"] !== "1.6")) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const inspectionId = `plugin-inspection:${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO plugin_artifacts
       (deployment_id, archive_sha256, bundle_sha256, r2_object_key, compressed_bytes,
        expanded_bytes, entry_count, sbom_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input["deploymentId"], row["archiveSha256"], row["bundleSha256"], row["r2ObjectKey"],
      Number(row["compressedBytes"] ?? 0), row["expandedBytes"], row["entryCount"],
      row["sbomVersion"], now.toISOString()),
    env.CONTROL_DB.prepare(
      `INSERT INTO plugin_inspections
       (deployment_id, inspection_id, archive_sha256, manifest_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
    ).bind(input["deploymentId"], inspectionId, row["archiveSha256"],
      JSON.stringify(manifest.data), now.toISOString(), expiresAt),
  ]);
  const audited = await audit(env, { deploymentId: String(input["deploymentId"]),
    principalId: String(input["principalId"]), eventType: "plugin.inspected", outcome: "success",
    requestId: String(input["requestId"]), metadata: { inspectionId, pluginId: manifest.data.id,
      archiveSha256: row["archiveSha256"] },
  });
  return audited ? Response.json({ inspectionId, manifest: manifest.data,
    archiveSha256: row["archiveSha256"], expiresAt }, { status: 201 })
    : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

async function installPlugin(request: Request, env: Bindings): Promise<Response> {
  const input = await pluginMutationInput(request);
  if (!input || typeof input["inspectionId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const inspection = await env.CONTROL_DB.prepare(
    `SELECT p.archive_sha256, p.manifest_json, p.expires_at, a.r2_object_key
     FROM plugin_inspections p JOIN plugin_artifacts a
       ON a.deployment_id = p.deployment_id AND a.archive_sha256 = p.archive_sha256
     WHERE p.deployment_id = ? AND p.inspection_id = ? AND p.status = 'accepted'`,
  ).bind(input["deploymentId"], input["inspectionId"]).first<{
    archive_sha256: string; manifest_json: string; expires_at: string; r2_object_key: string;
  }>();
  if (!inspection || Date.parse(inspection.expires_at) <= Date.now()) {
    return Response.json({ code: "PLUGIN_INSPECTION_EXPIRED" }, { status: 409 });
  }
  const manifest = pluginManifestSchema.parse(JSON.parse(inspection.manifest_json) as unknown);
  const replay = await env.CONTROL_DB.prepare(
    `SELECT installation_id, manifest_json FROM plugin_installations
     WHERE deployment_id = ? AND last_idempotency_key = ?`,
  ).bind(input["deploymentId"], input["idempotencyKey"]).first<{
    installation_id: string; manifest_json: string;
  }>().catch(() => null);
  if (replay) return Response.json({ installationId: replay.installation_id,
    manifest: JSON.parse(replay.manifest_json) as unknown });
  const installationId = `plugin-installation:${crypto.randomUUID()}`;
  const versionId = `plugin-version:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const needsCapabilityApproval = manifest.requestedCapabilityIds.length > 0;
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO plugin_installations
       (deployment_id, installation_id, plugin_id, plugin_version, artifact_sha256,
        manifest_json, granted_capability_ids_json, status, created_at, updated_at,
        active_version_id, last_idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input["deploymentId"], installationId, manifest.id, manifest.version,
      inspection.archive_sha256, JSON.stringify(manifest),
      JSON.stringify(needsCapabilityApproval ? [] : manifest.requestedCapabilityIds),
      needsCapabilityApproval ? "disabled" : "active", now, now,
      needsCapabilityApproval ? null : versionId, input["idempotencyKey"]),
    env.CONTROL_DB.prepare(
      `INSERT INTO plugin_versions
       (deployment_id, version_id, installation_id, plugin_id, plugin_version,
        archive_sha256, manifest_json, requested_capability_ids_json, status, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input["deploymentId"], versionId, installationId, manifest.id, manifest.version,
      inspection.archive_sha256, JSON.stringify(manifest),
      JSON.stringify(manifest.requestedCapabilityIds),
      needsCapabilityApproval ? "pending-approval" : "active", now,
      needsCapabilityApproval ? null : now),
  ]);
  if (needsCapabilityApproval) {
    const approvalRequest = { installationId, versionId,
      addedCapabilityIds: manifest.requestedCapabilityIds };
    const approvalId = `approval:${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await env.CONTROL_DB.prepare(
      `INSERT INTO approvals
       (deployment_id, approval_id, principal_id, capability_id, request_digest, preview_json,
        status, created_at, expires_at, request_json, task_id, gatekeeper_id)
       VALUES (?, ?, ?, 'plugin.capabilities.grant', ?, ?, 'pending', ?, ?, ?, ?,
         'gatekeeper:plugin-control')`,
    ).bind(input["deploymentId"], approvalId, input["principalId"],
      await createRequestDigest(approvalRequest), JSON.stringify({
        operation: "Grant plugin capabilities", destination: manifest.id,
        version: manifest.version, addedCapabilityIds: manifest.requestedCapabilityIds,
      }), now, expiresAt, JSON.stringify(approvalRequest), `plugin-install:${versionId}`).run();
    const audited = await audit(env, { deploymentId: String(input["deploymentId"]),
      principalId: String(input["principalId"]), eventType: "plugin.installation.approval.requested",
      outcome: "success", requestId: String(input["requestId"]),
      metadata: { installationId, pluginId: manifest.id, versionId, approvalId },
    });
    return audited ? Response.json({ installationId, versionId, manifest,
      status: "pending-approval", approvalId,
      addedCapabilityIds: manifest.requestedCapabilityIds }, { status: 202 })
      : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
  }
  const audited = await audit(env, { deploymentId: String(input["deploymentId"]),
    principalId: String(input["principalId"]), eventType: "plugin.installed", outcome: "success",
    requestId: String(input["requestId"]), metadata: { installationId, pluginId: manifest.id,
      version: manifest.version },
  });
  return audited ? Response.json({ installationId, versionId, manifest, status: "active" },
    { status: 201 }) : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

async function addPluginVersion(request: Request, env: Bindings): Promise<Response> {
  const input = await pluginMutationInput(request);
  if (!input || typeof input["installationId"] !== "string" ||
    typeof input["inspectionId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const installation = await env.CONTROL_DB.prepare(
    `SELECT plugin_id, granted_capability_ids_json, status FROM plugin_installations
     WHERE deployment_id = ? AND installation_id = ?`,
  ).bind(input["deploymentId"], input["installationId"]).first<{
    plugin_id: string; granted_capability_ids_json: string; status: string;
  }>();
  const inspection = await env.CONTROL_DB.prepare(
    `SELECT p.archive_sha256, p.manifest_json, p.expires_at FROM plugin_inspections p
     WHERE p.deployment_id = ? AND p.inspection_id = ? AND p.status = 'accepted'`,
  ).bind(input["deploymentId"], input["inspectionId"]).first<{
    archive_sha256: string; manifest_json: string; expires_at: string;
  }>();
  if (!installation || installation.status === "removed") {
    return Response.json({ code: "PLUGIN_INSTALLATION_NOT_FOUND" }, { status: 404 });
  }
  if (!inspection || Date.parse(inspection.expires_at) <= Date.now()) {
    return Response.json({ code: "PLUGIN_INSPECTION_EXPIRED" }, { status: 409 });
  }
  const manifest = pluginManifestSchema.parse(JSON.parse(inspection.manifest_json) as unknown);
  if (manifest.id !== installation.plugin_id) {
    return Response.json({ code: "PLUGIN_ID_MISMATCH" }, { status: 409 });
  }
  const granted = new Set(JSON.parse(installation.granted_capability_ids_json) as string[]);
  const addedCapabilities = manifest.requestedCapabilityIds.filter((id) => !granted.has(id));
  const versionId = `plugin-version:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO plugin_versions
     (deployment_id, version_id, installation_id, plugin_id, plugin_version,
      archive_sha256, manifest_json, requested_capability_ids_json, status, created_at, activated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(input["deploymentId"], versionId, input["installationId"], manifest.id,
    manifest.version, inspection.archive_sha256, JSON.stringify(manifest),
    JSON.stringify(manifest.requestedCapabilityIds),
    addedCapabilities.length > 0 ? "pending-approval" : "active", now,
    addedCapabilities.length > 0 ? null : now).run();
  if (addedCapabilities.length === 0) {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `UPDATE plugin_versions SET status = 'superseded'
         WHERE deployment_id = ? AND installation_id = ? AND version_id != ? AND status = 'active'`,
      ).bind(input["deploymentId"], input["installationId"], versionId),
      env.CONTROL_DB.prepare(
        `UPDATE plugin_installations SET plugin_version = ?, artifact_sha256 = ?, manifest_json = ?,
           active_version_id = ?, updated_at = ? WHERE deployment_id = ? AND installation_id = ?`,
      ).bind(manifest.version, inspection.archive_sha256, JSON.stringify(manifest), versionId, now,
        input["deploymentId"], input["installationId"]),
    ]);
    await audit(env, { deploymentId: String(input["deploymentId"]),
      principalId: String(input["principalId"]), eventType: "plugin.version.activated",
      outcome: "success", requestId: String(input["requestId"]),
      metadata: { installationId: input["installationId"], versionId, version: manifest.version },
    });
    return Response.json({ installationId: input["installationId"], versionId,
      status: "active", manifest }, { status: 201 });
  }
  const approvalRequest = { installationId: input["installationId"], versionId,
    addedCapabilityIds: addedCapabilities };
  const approvalId = `approval:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO approvals
     (deployment_id, approval_id, principal_id, capability_id, request_digest, preview_json,
      status, created_at, expires_at, request_json, task_id, gatekeeper_id)
     VALUES (?, ?, ?, 'plugin.capabilities.grant', ?, ?, 'pending', ?, ?, ?, ?,
       'gatekeeper:plugin-control')`,
  ).bind(input["deploymentId"], approvalId, input["principalId"],
    await createRequestDigest(approvalRequest), JSON.stringify({ operation: "Grant plugin capabilities",
      destination: manifest.id, version: manifest.version, addedCapabilityIds: addedCapabilities }),
    now, expiresAt, JSON.stringify(approvalRequest), `plugin-update:${versionId}`).run();
  await audit(env, { deploymentId: String(input["deploymentId"]),
    principalId: String(input["principalId"]), eventType: "plugin.version.approval.requested",
    outcome: "success", requestId: String(input["requestId"]),
    metadata: { installationId: input["installationId"], versionId, approvalId },
  });
  return Response.json({ installationId: input["installationId"], versionId,
    status: "pending-approval", approvalId, addedCapabilityIds: addedCapabilities,
    manifest }, { status: 202 });
}

async function rollbackPlugin(request: Request, env: Bindings): Promise<Response> {
  const input = await pluginMutationInput(request);
  if (!input || typeof input["installationId"] !== "string" ||
    typeof input["versionId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const target = await env.CONTROL_DB.prepare(
    `SELECT plugin_version, archive_sha256, manifest_json, requested_capability_ids_json
     FROM plugin_versions WHERE deployment_id = ? AND installation_id = ? AND version_id = ?
       AND status IN ('active', 'superseded')`,
  ).bind(input["deploymentId"], input["installationId"], input["versionId"]).first<{
    plugin_version: string; archive_sha256: string; manifest_json: string;
    requested_capability_ids_json: string;
  }>();
  if (!target) return Response.json({ code: "PLUGIN_VERSION_NOT_FOUND" }, { status: 404 });
  const now = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE plugin_versions SET status = 'superseded'
       WHERE deployment_id = ? AND installation_id = ? AND status = 'active'`,
    ).bind(input["deploymentId"], input["installationId"]),
    env.CONTROL_DB.prepare(
      `UPDATE plugin_versions SET status = 'active', activated_at = ?
       WHERE deployment_id = ? AND version_id = ?`,
    ).bind(now, input["deploymentId"], input["versionId"]),
    env.CONTROL_DB.prepare(
      `UPDATE plugin_installations SET plugin_version = ?, artifact_sha256 = ?, manifest_json = ?,
         granted_capability_ids_json = ?, active_version_id = ?, status = 'active', updated_at = ?
       WHERE deployment_id = ? AND installation_id = ? AND status != 'removed'`,
    ).bind(target.plugin_version, target.archive_sha256, target.manifest_json,
      target.requested_capability_ids_json, input["versionId"], now,
      input["deploymentId"], input["installationId"]),
  ]);
  await audit(env, { deploymentId: String(input["deploymentId"]),
    principalId: String(input["principalId"]), eventType: "plugin.version.rolled-back",
    outcome: "success", requestId: String(input["requestId"]),
    metadata: { installationId: input["installationId"], versionId: input["versionId"] },
  });
  return Response.json({ installationId: input["installationId"],
    versionId: input["versionId"], status: "active" });
}

async function mutatePlugin(request: Request, env: Bindings): Promise<Response> {
  const input = await pluginMutationInput(request);
  if (!input || typeof input["installationId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const current = await env.CONTROL_DB.prepare(
    `SELECT status FROM plugin_installations WHERE deployment_id = ? AND installation_id = ?`,
  ).bind(input["deploymentId"], input["installationId"]).first<{ status: string }>();
  if (!current) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await env.CONTROL_DB.prepare(
      `UPDATE plugin_installations SET status = 'removed', removed_at = ?, updated_at = ?
       WHERE deployment_id = ? AND installation_id = ?`,
    ).bind(now, now, input["deploymentId"], input["installationId"]).run();
    await env.CONTROL_DB.prepare(
      `UPDATE plugin_versions SET status = 'revoked'
       WHERE deployment_id = ? AND installation_id = ? AND status != 'revoked'`,
    ).bind(input["deploymentId"], input["installationId"]).run();
  } else {
    if (typeof input["enabled"] !== "boolean") {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    await env.CONTROL_DB.prepare(
      `UPDATE plugin_installations SET status = ?, updated_at = ?
       WHERE deployment_id = ? AND installation_id = ? AND status != 'removed'`,
    ).bind(input["enabled"] ? "active" : "disabled", now,
      input["deploymentId"], input["installationId"]).run();
  }
  const status = request.method === "DELETE" ? "removed" : input["enabled"] ? "active" : "disabled";
  const audited = await audit(env, { deploymentId: String(input["deploymentId"]),
    principalId: String(input["principalId"]), eventType: request.method === "DELETE"
      ? "plugin.removed" : "plugin.status.changed", outcome: "success",
    requestId: String(input["requestId"]), metadata: { installationId: input["installationId"], status },
  });
  return audited ? Response.json({ installationId: input["installationId"], status })
    : Response.json({ code: "AUDIT_UNAVAILABLE" }, { status: 503 });
}

async function pluginCapabilityCall(request: Request): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["capabilityId"] !== "string") {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  return Response.json({ code: "CAPABILITY_EXECUTION_REQUIRES_OWNER_APPROVAL" }, { status: 409 });
}

async function recordPluginExecution(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const input = value as Record<string, unknown>;
  if (typeof input["deploymentId"] !== "string" || typeof input["executionId"] !== "string" ||
    typeof input["installationId"] !== "string" || typeof input["toolId"] !== "string" ||
    typeof input["durationMs"] !== "number" || typeof input["meter"] !== "object" ||
    input["meter"] === null || !["success", "failure", "timeout", "unknown"].includes(
      String(input["outcome"]))) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date();
  await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO plugin_execution_metadata
     (deployment_id, execution_id, installation_id, tool_id, result_digest, duration_ms,
      meter_json, outcome, error_code, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(input["deploymentId"], input["executionId"], input["installationId"], input["toolId"],
    typeof input["resultDigest"] === "string" ? input["resultDigest"] : null,
    Math.max(0, Math.round(input["durationMs"])), JSON.stringify(input["meter"]), input["outcome"],
    typeof input["errorCode"] === "string" ? input["errorCode"] : null, now.toISOString(),
    new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString()).run();
  return Response.json({ recorded: true }, { status: 201 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/internal/v1/identity/owner/authenticate"
    ) {
      return authenticateOwner(request, env.CONTROL_DB);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/internal/v1/delegated/source/authorize"
    ) {
      return authorizeDelegatedSource(request, env.CONTROL_DB);
    }
    if (request.method === "POST" &&
      url.pathname === "/internal/v1/delegated/sources/authorized") {
      return listAuthorizedDelegatedSources(request, env.CONTROL_DB);
    }
    if ((request.method === "GET" || request.method === "POST" || request.method === "PATCH") &&
      url.pathname === "/internal/v1/delegated/sources") {
      return delegatedSources(request, env);
    }
    if (request.method === "DELETE" && url.pathname === "/internal/v1/delegated/sources") {
      return deleteDelegatedSource(request, env);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/approvals") {
      return listApprovals(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/approvals") {
      return createApproval(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/approvals/decision") {
      return decideApproval(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/approvals/execution") {
      return recordApprovalExecution(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/approvals/execution/reconcile") {
      return reconcileApprovalExecution(request, env);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/audit") {
      return listAudit(request, env);
    }
    if (
      (request.method === "GET" || request.method === "PATCH") &&
      url.pathname === "/internal/v1/settings/budgets"
    ) {
      return budgetSettings(request, env);
    }
    if (
      (request.method === "GET" || request.method === "PATCH") &&
      url.pathname === "/internal/v1/settings/providers"
    ) {
      return providerSettings(request, env);
    }
    if ((request.method === "GET" || request.method === "PATCH") &&
      url.pathname === "/internal/v1/settings/preferences") {
      return ownerPreferences(request, env);
    }
    if ((request.method === "GET" || request.method === "POST" || request.method === "DELETE") &&
      url.pathname === "/internal/v1/conversations/registry") {
      return conversationRegistry(request, env);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/storage/status") {
      return conversationStorageStatus(request, env);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/plugins") {
      return listPlugins(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugins/inspections") {
      return recordPluginInspection(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugins/install") {
      return installPlugin(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugins/version") {
      return addPluginVersion(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugins/rollback") {
      return rollbackPlugin(request, env);
    }
    if ((request.method === "PATCH" || request.method === "DELETE") &&
      url.pathname === "/internal/v1/plugins/installation") {
      return mutatePlugin(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugin/capability-call") {
      return pluginCapabilityCall(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/plugin/executions") {
      return recordPluginExecution(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/discord/link-codes") {
      return createDiscordLinkCode(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/discord/link-codes/consume") {
      return consumeDiscordLinkCode(request, env);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/discord/link") {
      return getDiscordLink(request, env, false);
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/discord/resolve") {
      return getDiscordLink(request, env, true);
    }
    if (request.method === "DELETE" && url.pathname === "/internal/v1/discord/link") {
      return revokeDiscordLink(request, env);
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
} satisfies ExportedHandler<Bindings>;
