import { sha256Hex } from "@opap/security";
import { createRequestDigest, issueExecutionLease } from "@opap/approval";
import { importJWK, type JWK } from "jose";
import {
  DEFAULT_OWNER_MODEL_SETTINGS,
  cloudCostPolicySchema,
  delegatedSourceAclSchema,
  modelProviderSettingSchema,
  ownerModelSettingsSchema,
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
    `SELECT source_id, source_type, resource_ids_json, acl_json
     FROM delegated_sources
     WHERE deployment_id = ? AND source_id = ? AND enabled = 1`,
  ).bind(input["deploymentId"], input["sourceId"]).first<DelegatedSourceRow>();
  if (!source) {
    return Response.json({ code: "DELEGATED_ACL_DENIED" }, { status: 403 });
  }
  let aclValue: unknown;
  let resourceValue: unknown;
  try {
    aclValue = JSON.parse(source.acl_json) as unknown;
    resourceValue = JSON.parse(source.resource_ids_json) as unknown;
  } catch {
    return Response.json({ code: "SOURCE_CONFIGURATION_INVALID" }, { status: 503 });
  }
  const acl = delegatedSourceAclSchema.safeParse(aclValue);
  if (
    !acl.success ||
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
  });
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
      input["gatekeeperId"] !== "gatekeeper:model-router") ||
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
    input["capabilityId"] !== "model.connector-results.send") {
    return Response.json({ code: "CAPABILITY_NOT_ALLOWED" }, { status: 403 });
  }
  const expectedGatekeeper = String(input["capabilityId"]).startsWith("github.")
    ? "gatekeeper:github-personal"
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
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
} satisfies ExportedHandler<Bindings>;
