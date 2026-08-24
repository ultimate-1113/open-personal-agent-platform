import {
  EXPORT_FORMAT,
  EXPORT_RETENTION_MS,
  sanitizeExportValue,
  sha256Hex,
  type ExportFileRecord,
  type ExportManifest,
} from "@opap/maintenance";

type Bindings = {
  CONTROL_DB: D1Database;
  PRIVATE_R2: R2Bucket;
  CONVERSATIONS: DurableObjectNamespace;
};

type CreateExportInput = {
  deploymentId: string;
  principalId: string;
  idempotencyKey: string;
};

const isCreateExportInput = (value: unknown): value is CreateExportInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["deploymentId", "principalId", "idempotencyKey"].every(
    (key) => typeof input[key] === "string" && String(input[key]).length > 0,
  );
};

const putExportFile = async (
  env: Bindings,
  input: { deploymentId: string; exportId: string; name: string; content: Uint8Array;
    createdAt: string; expiresAt: string },
): Promise<ExportFileRecord> => {
  const sha256 = await sha256Hex(input.content);
  const key = `exports/${encodeURIComponent(input.deploymentId)}/${input.exportId}/${input.name}`;
  await env.PRIVATE_R2.put(key, input.content, {
    httpMetadata: { contentType: input.name.endsWith(".json")
      ? "application/json" : "application/x-ndjson" },
    customMetadata: { exportId: input.exportId, sha256, expiresAt: input.expiresAt },
  });
  await env.CONTROL_DB.prepare(
    `INSERT INTO export_files
     (deployment_id, export_id, file_name, r2_object_key, byte_size, sha256, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(input.deploymentId, input.exportId, input.name, key, input.content.byteLength,
    sha256, input.createdAt, input.expiresAt).run();
  return { name: input.name, bytes: input.content.byteLength, sha256 };
};

async function createExport(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (!isCreateExportInput(value)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const existing = await env.CONTROL_DB.prepare(
    `SELECT job_id, status, result_json, error_code, created_at, updated_at, expires_at
     FROM maintenance_jobs WHERE deployment_id = ? AND job_type = 'export' AND idempotency_key = ?`,
  ).bind(value.deploymentId, value.idempotencyKey).first<{
    job_id: string; status: string; result_json: string | null; error_code: string | null;
    created_at: string; updated_at: string; expires_at: string | null;
  }>();
  if (existing) return Response.json(jobJson(existing));
  const exportId = `export:${crypto.randomUUID()}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + EXPORT_RETENTION_MS).toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO maintenance_jobs
     (deployment_id, job_id, job_type, status, target_id, idempotency_key,
      created_at, updated_at, expires_at)
     VALUES (?, ?, 'export', 'running', ?, ?, ?, ?, ?)`,
  ).bind(value.deploymentId, exportId, exportId, value.idempotencyKey,
    createdAt, createdAt, expiresAt).run();
  try {
    const registry = await env.CONTROL_DB.prepare(
      `SELECT conversation_id FROM conversation_registry
       WHERE deployment_id = ? AND owner_principal_id = ? AND deleted_at IS NULL
       ORDER BY created_at`,
    ).bind(value.deploymentId, value.principalId).all<{ conversation_id: string }>();
    const lines: string[] = [];
    for (const row of registry.results) {
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(row.conversation_id));
      const response = await stub.fetch("https://conversation.internal/state").catch(() => undefined);
      if (!response?.ok) continue;
      const rawState: unknown = await response.json();
      const state = sanitizeExportValue(rawState) as Record<string, unknown>;
      if (Array.isArray(state["messages"])) {
        state["messages"] = (state["messages"] as unknown[]).map((message: unknown) => {
          if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
          const rowValue = message as Record<string, unknown>;
          const policy = rowValue["informationPolicy"];
          return typeof policy === "object" && policy !== null &&
            (policy as Record<string, unknown>)["sensitivity"] === "secret"
            ? { ...rowValue, content: "[REDACTED]" } : rowValue;
        });
      }
      lines.push(JSON.stringify(state));
    }
    const encoder = new TextEncoder();
    const conversationFile = await putExportFile(env, { deploymentId: value.deploymentId,
      exportId, name: "conversations.ndjson", content: encoder.encode(`${lines.join("\n")}\n`),
      createdAt, expiresAt });
    const manifest: ExportManifest = { format: EXPORT_FORMAT, deploymentId: value.deploymentId,
      exportId, createdAt, expiresAt, files: [conversationFile] };
    const manifestFile = await putExportFile(env, { deploymentId: value.deploymentId,
      exportId, name: "manifest.json", content: encoder.encode(JSON.stringify(manifest, null, 2)),
      createdAt, expiresAt });
    manifest.files.push(manifestFile);
    const result = { exportId, files: manifest.files, expiresAt };
    await env.CONTROL_DB.prepare(
      `UPDATE maintenance_jobs SET status = 'succeeded', result_json = ?, updated_at = ?
       WHERE deployment_id = ? AND job_id = ?`,
    ).bind(JSON.stringify(result), new Date().toISOString(), value.deploymentId, exportId).run();
    return Response.json({ jobId: exportId, status: "succeeded", result }, { status: 201 });
  } catch {
    await env.CONTROL_DB.prepare(
      `UPDATE maintenance_jobs SET status = 'failed', error_code = 'EXPORT_FAILED', updated_at = ?
       WHERE deployment_id = ? AND job_id = ?`,
    ).bind(new Date().toISOString(), value.deploymentId, exportId).run();
    return Response.json({ code: "EXPORT_FAILED", jobId: exportId }, { status: 503 });
  }
}

const jobJson = (row: { job_id: string; status: string; result_json: string | null;
  error_code: string | null; created_at: string; updated_at: string; expires_at: string | null }) => ({
  jobId: row.job_id, status: row.status,
  result: row.result_json ? JSON.parse(row.result_json) as unknown : null,
  errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

async function listExports(request: Request, env: Bindings): Promise<Response> {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const rows = await env.CONTROL_DB.prepare(
    `SELECT job_id, status, result_json, error_code, created_at, updated_at, expires_at
     FROM maintenance_jobs WHERE deployment_id = ? AND job_type = 'export'
     ORDER BY created_at DESC LIMIT 100`,
  ).bind(deploymentId).all<{
    job_id: string; status: string; result_json: string | null; error_code: string | null;
    created_at: string; updated_at: string; expires_at: string | null;
  }>();
  return Response.json({ exports: rows.results.map(jobJson) });
}

async function getJob(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  const jobId = url.searchParams.get("jobId");
  if (!deploymentId || !jobId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  const row = await env.CONTROL_DB.prepare(
    `SELECT job_id, status, result_json, error_code, created_at, updated_at, expires_at
     FROM maintenance_jobs WHERE deployment_id = ? AND job_id = ?`,
  ).bind(deploymentId, jobId).first<{
    job_id: string; status: string; result_json: string | null; error_code: string | null;
    created_at: string; updated_at: string; expires_at: string | null;
  }>();
  return row ? Response.json(jobJson(row)) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
}

async function getExportFile(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deploymentId");
  const exportId = url.searchParams.get("exportId");
  const fileName = url.searchParams.get("fileName");
  if (!deploymentId || !exportId || !fileName || !/^[a-z0-9._-]+$/u.test(fileName)) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const row = await env.CONTROL_DB.prepare(
    `SELECT r2_object_key, expires_at FROM export_files
     WHERE deployment_id = ? AND export_id = ? AND file_name = ?`,
  ).bind(deploymentId, exportId, fileName).first<{ r2_object_key: string; expires_at: string }>();
  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  const object = await env.PRIVATE_R2.get(row.r2_object_key);
  if (!object) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": fileName.endsWith(".json") ? "application/json" : "application/x-ndjson",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
  } });
}

async function runRetention(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  const expiredFiles = await env.CONTROL_DB.prepare(
    `SELECT deployment_id, export_id, file_name, r2_object_key FROM export_files
     WHERE expires_at <= ? LIMIT 500`,
  ).bind(now).all<{ deployment_id: string; export_id: string; file_name: string;
    r2_object_key: string }>();
  for (const row of expiredFiles.results) await env.PRIVATE_R2.delete(row.r2_object_key);
  if (expiredFiles.results.length > 0) {
    await env.CONTROL_DB.batch(expiredFiles.results.map((row) => env.CONTROL_DB.prepare(
      `DELETE FROM export_files WHERE deployment_id = ? AND export_id = ? AND file_name = ?`,
    ).bind(row.deployment_id, row.export_id, row.file_name)));
  }
  await env.CONTROL_DB.prepare(
    `DELETE FROM maintenance_jobs WHERE job_type = 'export' AND expires_at <= ?`,
  ).bind(now).run();
  await env.CONTROL_DB.prepare(
    `UPDATE plugin_inspections SET status = 'expired'
     WHERE status = 'accepted' AND expires_at <= ?`,
  ).bind(now).run();
  await env.CONTROL_DB.prepare(
    `DELETE FROM plugin_inspections WHERE status IN ('expired', 'rejected') AND expires_at <= ?`,
  ).bind(now).run();
  await env.CONTROL_DB.prepare(
    `DELETE FROM plugin_execution_metadata WHERE expires_at <= ?`,
  ).bind(now).run();
  const unusedArtifacts = await env.CONTROL_DB.prepare(
    `SELECT a.deployment_id, a.archive_sha256, a.r2_object_key FROM plugin_artifacts a
     WHERE NOT EXISTS (SELECT 1 FROM plugin_inspections i
       WHERE i.deployment_id = a.deployment_id AND i.archive_sha256 = a.archive_sha256
         AND i.status = 'accepted')
       AND NOT EXISTS (SELECT 1 FROM plugin_versions v
         WHERE v.deployment_id = a.deployment_id AND v.archive_sha256 = a.archive_sha256) LIMIT 100`,
  ).all<{ deployment_id: string; archive_sha256: string; r2_object_key: string }>();
  for (const row of unusedArtifacts.results) await env.PRIVATE_R2.delete(row.r2_object_key);
  if (unusedArtifacts.results.length > 0) {
    await env.CONTROL_DB.batch(unusedArtifacts.results.map((row) => env.CONTROL_DB.prepare(
      `DELETE FROM plugin_artifacts WHERE deployment_id = ? AND archive_sha256 = ?`,
    ).bind(row.deployment_id, row.archive_sha256)));
  }
  const deployments = await env.CONTROL_DB.prepare(
    `SELECT deployment_id, COALESCE(SUM(estimated_storage_bytes), 0) AS used_bytes
     FROM conversation_registry WHERE deleted_at IS NULL GROUP BY deployment_id`,
  ).all<{ deployment_id: string; used_bytes: number }>();
  const period = now.slice(0, 7);
  for (const row of deployments.results) {
    await env.CONTROL_DB.prepare(
      `INSERT INTO storage_rollups (deployment_id, resource, period, used_bytes, measured_at)
       VALUES (?, 'conversation-do-sqlite', ?, ?, ?)
       ON CONFLICT(deployment_id, resource, period) DO UPDATE SET
         used_bytes = excluded.used_bytes, measured_at = excluded.measured_at`,
    ).bind(row.deployment_id, period, row.used_bytes, now).run();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/internal/v1/exports") return createExport(request, env);
    if (request.method === "GET" && path === "/internal/v1/exports") return listExports(request, env);
    if (request.method === "GET" && path === "/internal/v1/maintenance/jobs") return getJob(request, env);
    if (request.method === "GET" && path === "/internal/v1/exports/file") return getExportFile(request, env);
    return new Response("Not Found", { status: 404 });
  },
  scheduled(_controller, env, context): void {
    context.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Bindings>;
