import {
  ContainerProxy,
  Sandbox as BaseSandbox,
  StaleProcessHandleError,
  getSandbox,
} from "@cloudflare/sandbox";
import { SANDBOX_LIMITS, estimateSandboxReservation } from "@opap/cost-control";
import { inspectPluginArchive, readPluginArchive } from "@opap/plugin-sdk";
import { digestJson } from "@opap/security";
import type { JsonValue } from "@opap/contracts";

export { ContainerProxy };

type Bindings = {
  DEPLOYMENT_ID: string;
  PLUGIN_RUNTIME_PROTOCOL_VERSION: string;
  PLUGIN_INVOCATION_SIGNING_KEY: string;
  PRIVATE_R2: R2Bucket;
  CONTROL: Fetcher;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  PLUGIN_COORDINATOR: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
};

export class Sandbox extends BaseSandbox<Bindings> {
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts = ["capability-broker.opap.internal"];

  static override outboundByHost = {
    "capability-broker.opap.internal": async (request: Request, env: Cloudflare.Env) => {
      const installationId = request.headers.get("x-opap-installation-id");
      if (!installationId) return responseCode(403, "CAPABILITY_BROKER_DENIED");
      const coordinator = env.PLUGIN_COORDINATOR.get(
        env.PLUGIN_COORDINATOR.idFromName(env.DEPLOYMENT_ID),
      );
      return coordinator.fetch("https://plugin-coordinator.internal/broker", request);
    },
  };
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const responseCode = (status: number, code: string): Response =>
  Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });

const requestBytes = async (request: Request): Promise<Uint8Array | undefined> => {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return undefined;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_BODY_BYTES ? bytes : undefined;
};

const artifactKey = (deploymentId: string, archiveSha256: string): string =>
  `plugins/${encodeURIComponent(deploymentId)}/artifacts/${archiveSha256}.tgz`;

async function inspect(request: Request, env: Bindings): Promise<Response> {
  const bytes = await requestBytes(request);
  if (!bytes) return responseCode(413, "PLUGIN_ARCHIVE_TOO_LARGE");
  try {
    const inspection = await inspectPluginArchive(bytes);
    const key = artifactKey(env.DEPLOYMENT_ID, inspection.archiveSha256);
    if (!await env.PRIVATE_R2.head(key)) {
      await env.PRIVATE_R2.put(key, bytes, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { archiveSha256: inspection.archiveSha256,
          bundleSha256: inspection.bundleSha256, format: "opap-plugin-archive/v1" },
      });
    }
    return Response.json({ ...inspection, compressedBytes: bytes.byteLength, r2ObjectKey: key,
      protocolVersion: env.PLUGIN_RUNTIME_PROTOCOL_VERSION }, { status: 201 });
  } catch (error) {
    return Response.json({ code: "PLUGIN_INSPECTION_FAILED",
      message: error instanceof Error ? error.message : "Plugin inspection failed" }, { status: 400 });
  }
}

type InvokeInput = {
  deploymentId: string;
  installationId: string;
  archiveSha256: string;
  entrypoint: string;
  toolId: string;
  input: unknown;
  invocationToken: string;
  allowedCapabilityIds: string[];
  protocolVersion: string;
};

type InvocationClaims = { installationId: string; toolId: string; requestDigest: string;
  expiresAt: string; nonce: string };

const base64UrlDecode = (value: string): Uint8Array => Uint8Array.from(
  atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")),
  (character) => character.charCodeAt(0),
);

async function verifyInvocationToken(value: InvokeInput, keyValue: string): Promise<boolean> {
  const [payloadEncoded, signatureEncoded, extra] = value.invocationToken.split(".");
  if (!payloadEncoded || !signatureEncoded || extra) return false;
  let claims: InvocationClaims;
  try { claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadEncoded))) as InvocationClaims; }
  catch { return false; }
  if (claims.installationId !== value.installationId || claims.toolId !== value.toolId ||
    typeof claims.nonce !== "string" || Date.parse(claims.expiresAt) <= Date.now() ||
    Date.parse(claims.expiresAt) > Date.now() + 5 * 60_000 ||
    claims.requestDigest !== await digestJson(value.input as JsonValue)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureEncoded).slice().buffer,
    new TextEncoder().encode(payloadEncoded));
}

const billingPeriod = (date = new Date()): string => date.toISOString().slice(0, 7);

async function reserveContainer(env: Bindings, invocationToken: string): Promise<{
  quota: DurableObjectStub; reservationIds: string[];
} | Response> {
  const quota = env.QUOTA.get(env.QUOTA.idFromName(env.DEPLOYMENT_ID));
  const reservation = estimateSandboxReservation(SANDBOX_LIMITS.timeoutSeconds);
  const entries = Object.entries(reservation);
  const reservationIds = entries.map(([resource]) => `${invocationToken}:${resource}`);
  const response = await quota.fetch("https://quota.internal/reserve-batch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reserve-batch", deploymentId: env.DEPLOYMENT_ID,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      items: entries.map(([resource, amount], index) => ({ reservationId: reservationIds[index],
        idempotencyKey: `plugin:${invocationToken}:${resource}`, scopeId: "deployment",
        resource, amount, period: billingPeriod() })) }),
  });
  return response.ok ? { quota, reservationIds } : new Response(response.body, response);
}

const settleContainer = async (reservation: { quota: DurableObjectStub; reservationIds: string[] },
  deploymentId: string, executionSeconds: number): Promise<void> => {
  const actual = Object.values(estimateSandboxReservation(Math.max(0.001,
    Math.min(SANDBOX_LIMITS.timeoutSeconds, executionSeconds))));
  await reservation.quota.fetch("https://quota.internal/settle-batch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "settle-batch", deploymentId,
      items: reservation.reservationIds.map((reservationId, index) => ({ reservationId,
        actualAmount: actual[index] ?? 0 })) }),
  });
};

const isInvokeInput = (value: unknown): value is InvokeInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["deploymentId", "installationId", "archiveSha256", "entrypoint", "toolId",
    "invocationToken", "protocolVersion"].every((key) => typeof input[key] === "string") &&
    /^[a-f0-9]{64}$/u.test(String(input["archiveSha256"])) &&
    Array.isArray(input["allowedCapabilityIds"]) &&
    input["allowedCapabilityIds"].every((item) => typeof item === "string");
};

const runnerSource = `
const [pluginPath, inputPath, toolId] = process.argv.slice(2);
const plugin = await import(pluginPath);
const input = JSON.parse(await (await import('node:fs/promises')).readFile(inputPath, 'utf8'));
const call = async (capabilityId, capabilityInput) => {
  const response = await fetch('http://capability-broker.opap.internal/call', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + process.env.OPAP_INVOCATION_TOKEN,
      'x-opap-installation-id': process.env.OPAP_INSTALLATION_ID
    },
    body: JSON.stringify({ capabilityId, input: capabilityInput })
  });
  if (!response.ok) throw new Error('CAPABILITY_BROKER_DENIED');
  return response.json();
};
const invoke = plugin.default?.invoke ?? plugin.invoke;
if (typeof invoke !== 'function') throw new Error('PLUGIN_INVOKE_MISSING');
const result = await invoke({ toolId, input, capabilities: { call } });
process.stdout.write(JSON.stringify(result));
`;

async function invoke(request: Request, env: Bindings): Promise<Response> {
  const value: unknown = await request.json().catch(() => null);
  if (!isInvokeInput(value) || value.deploymentId !== env.DEPLOYMENT_ID) {
    return responseCode(400, "INVALID_REQUEST");
  }
  const currentProtocol = Number.parseInt(env.PLUGIN_RUNTIME_PROTOCOL_VERSION, 10);
  if (!Number.isInteger(currentProtocol) || ![String(currentProtocol), String(currentProtocol - 1)]
    .includes(value.protocolVersion)) {
    return responseCode(409, "PLUGIN_RUNTIME_PROTOCOL_UNSUPPORTED");
  }
  if (!await verifyInvocationToken(value, env.PLUGIN_INVOCATION_SIGNING_KEY).catch(() => false)) {
    return responseCode(403, "INVOCATION_TOKEN_INVALID");
  }
  const coordinator = env.PLUGIN_COORDINATOR.get(
    env.PLUGIN_COORDINATOR.idFromName(value.deploymentId),
  );
  const acquire = await coordinator.fetch("https://plugin-coordinator.internal/acquire", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installationId: value.installationId,
      invocationToken: value.invocationToken, allowedCapabilityIds: value.allowedCapabilityIds }),
  });
  if (!acquire.ok) return new Response(acquire.body, acquire);
  const startedAt = Date.now();
  let runtimeStage = "reserve-container";
  let containerReservation: { quota: DurableObjectStub; reservationIds: string[] } | undefined;
  const executionId = `plugin-execution:${crypto.randomUUID()}`;
  const finish = async (response: Response, outcome: "success" | "failure" | "timeout" | "unknown",
    errorCode?: string, result?: unknown): Promise<Response> => {
    const durationMs = Date.now() - startedAt;
    const meter = estimateSandboxReservation(Math.max(0.001,
      Math.min(SANDBOX_LIMITS.timeoutSeconds, durationMs / 1_000)));
    await env.CONTROL.fetch("https://control.internal/internal/v1/plugin/executions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        deploymentId: env.DEPLOYMENT_ID, executionId, installationId: value.installationId,
        toolId: value.toolId, durationMs, meter, outcome, ...(errorCode ? { errorCode } : {}),
        ...(result === undefined ? {} : { resultDigest: await digestJson(result as JsonValue) }),
      }),
    }).catch(() => undefined);
    return response;
  };
  try {
    const reserved = await reserveContainer(env, value.invocationToken);
    if (reserved instanceof Response) return reserved;
    containerReservation = reserved;
    runtimeStage = "read-artifact";
    const artifact = await env.PRIVATE_R2.get(artifactKey(value.deploymentId, value.archiveSha256));
    if (!artifact) return finish(responseCode(404, "PLUGIN_ARTIFACT_NOT_FOUND"),
      "failure", "PLUGIN_ARTIFACT_NOT_FOUND");
    const entries = await readPluginArchive(new Uint8Array(await artifact.arrayBuffer()));
    const bundle = entries.find((entry) => entry.path === value.entrypoint && entry.kind === "file");
    if (!bundle) return finish(responseCode(409, "PLUGIN_ENTRYPOINT_NOT_FOUND"),
      "failure", "PLUGIN_ENTRYPOINT_NOT_FOUND");
    const sandboxScopeDigest = await digestJson({
      deploymentId: value.deploymentId,
      installationId: value.installationId,
    });
    const sandboxId = `plugin-${sandboxScopeDigest.slice(0, 56)}`;
    runtimeStage = "connect-sandbox";
    const sandbox = getSandbox(env.SANDBOX, sandboxId, {
      keepAlive: SANDBOX_LIMITS.keepAlive,
      sleepAfter: `${SANDBOX_LIMITS.sleepAfterSeconds}s`,
    });
    const prefix = `/workspace/opap/${crypto.randomUUID()}`;
    runtimeStage = "prepare-workspace";
    await sandbox.mkdir(prefix, { recursive: true });
    await sandbox.writeFile(`${prefix}/plugin.mjs`, new Blob([bundle.content as BlobPart]).stream());
    await sandbox.writeFile(`${prefix}/input.json`, JSON.stringify(value.input));
    await sandbox.writeFile(`${prefix}/runner.mjs`, runnerSource);
    runtimeStage = "execute-plugin";
    const process = await sandbox.exec([
      "node", `${prefix}/runner.mjs`, `${prefix}/plugin.mjs`, `${prefix}/input.json`, value.toolId,
    ], {
      timeout: SANDBOX_LIMITS.timeoutSeconds * 1_000,
      env: { OPAP_INVOCATION_TOKEN: value.invocationToken,
        OPAP_INSTALLATION_ID: value.installationId },
    });
    const output = await process.output({ encoding: "utf8",
      maxBytes: SANDBOX_LIMITS.outputBytes + 1 });
    runtimeStage = "validate-output";
    if (output.truncated || output.stdout.length > SANDBOX_LIMITS.outputBytes) {
      await process.kill(9).catch(() => undefined);
      return finish(responseCode(413, "PLUGIN_OUTPUT_LIMIT_REACHED"),
        "failure", "PLUGIN_OUTPUT_LIMIT_REACHED");
    }
    if (output.timedOut) return finish(responseCode(408, "PLUGIN_TIMEOUT"),
      "timeout", "PLUGIN_TIMEOUT");
    if (output.exitCode !== 0) return finish(responseCode(422, "PLUGIN_EXECUTION_FAILED"),
      "failure", "PLUGIN_EXECUTION_FAILED");
    let result: unknown;
    try { result = JSON.parse(output.stdout) as unknown; } catch {
      return finish(responseCode(422, "PLUGIN_RESULT_INVALID"),
        "failure", "PLUGIN_RESULT_INVALID");
    }
    return finish(Response.json({ result, durationMs: Date.now() - startedAt,
      reservation: estimateSandboxReservation(Math.max(0.001,
        Math.min(SANDBOX_LIMITS.timeoutSeconds, (Date.now() - startedAt) / 1_000))),
      protocolVersion: env.PLUGIN_RUNTIME_PROTOCOL_VERSION }), "success", undefined, result);
  } catch (error) {
    const code = error instanceof StaleProcessHandleError
      ? "STALE_PROCESS_HANDLE" : "PLUGIN_RUNTIME_UNAVAILABLE";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const diagnostic = Response.json({ code, detail: `${runtimeStage}: ${errorName}` }, {
      status: error instanceof StaleProcessHandleError ? 409 : 503,
      headers: { "Cache-Control": "no-store" },
    });
    return finish(diagnostic,
      "failure", code);
  } finally {
    if (containerReservation) {
      await settleContainer(containerReservation, env.DEPLOYMENT_ID,
        (Date.now() - startedAt) / 1_000).catch(() => undefined);
    }
    await coordinator.fetch("https://plugin-coordinator.internal/release", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invocationToken: value.invocationToken }),
    }).catch(() => undefined);
  }
}

export class PluginCoordinator {
  readonly #sql: SqlStorage;
  readonly #env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.#sql = state.storage.sql;
    this.#env = env;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS active_invocations (
        invocation_token TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        allowed_capability_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_invocation_tokens (
        invocation_token TEXT PRIMARY KEY,
        consumed_at TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/acquire") {
      const value: unknown = await request.json().catch(() => null);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return responseCode(400, "INVALID_REQUEST");
      }
      const input = value as Record<string, unknown>;
      if (typeof input["installationId"] !== "string" ||
        typeof input["invocationToken"] !== "string" ||
        !Array.isArray(input["allowedCapabilityIds"]) ||
        !input["allowedCapabilityIds"].every((item) => typeof item === "string")) {
        return responseCode(400, "INVALID_REQUEST");
      }
      const count = [...this.#sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM active_invocations",
      )][0]?.count ?? 0;
      if (count >= SANDBOX_LIMITS.concurrency) return responseCode(429, "PLUGIN_CONCURRENCY_LIMIT");
      try {
        this.#sql.exec("DELETE FROM consumed_invocation_tokens WHERE consumed_at < ?",
          new Date(Date.now() - 10 * 60_000).toISOString());
        this.#sql.exec("INSERT INTO consumed_invocation_tokens (invocation_token, consumed_at) VALUES (?, ?)",
          input["invocationToken"], new Date().toISOString());
        this.#sql.exec(
          `INSERT INTO active_invocations
           (invocation_token, installation_id, allowed_capability_ids_json, created_at)
           VALUES (?, ?, ?, ?)`, input["invocationToken"], input["installationId"],
          JSON.stringify(input["allowedCapabilityIds"]), new Date().toISOString(),
        );
      } catch {
        return responseCode(409, "INVOCATION_TOKEN_REPLAYED");
      }
      return Response.json({ acquired: true });
    }
    if (request.method === "POST" && path === "/release") {
      const value: Record<string, unknown> = await request.json<Record<string, unknown>>()
        .catch(() => ({}));
      if (typeof value["invocationToken"] === "string") {
        this.#sql.exec("DELETE FROM active_invocations WHERE invocation_token = ?",
          value["invocationToken"]);
      }
      return Response.json({ released: true });
    }
    if (request.method === "POST" && path === "/broker") {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "");
      const installationId = request.headers.get("x-opap-installation-id");
      if (!token || !installationId) return responseCode(403, "CAPABILITY_BROKER_DENIED");
      const active = [...this.#sql.exec<{ allowed_capability_ids_json: string }>(
        `SELECT allowed_capability_ids_json FROM active_invocations
         WHERE invocation_token = ? AND installation_id = ?`, token, installationId,
      )][0];
      const value: Record<string, unknown> = await request.json<Record<string, unknown>>()
        .catch(() => ({}));
      const allowed = active ? JSON.parse(active.allowed_capability_ids_json) as unknown : [];
      if (!Array.isArray(allowed) || typeof value["capabilityId"] !== "string" ||
        !allowed.includes(value["capabilityId"])) {
        return responseCode(403, "CAPABILITY_BROKER_DENIED");
      }
      return this.#env.CONTROL.fetch("https://control.internal/internal/v1/plugin/capability-call", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId, invocationToken: token, ...value }),
      });
    }
    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      const current = Number.parseInt(env.PLUGIN_RUNTIME_PROTOCOL_VERSION, 10);
      return Response.json({ status: "ok", protocolVersion: String(current),
        supportedProtocolVersions: [String(current), String(current - 1)] });
    }
    if (request.method === "POST" && path === "/internal/v1/plugins/inspect") return inspect(request, env);
    if (request.method === "POST" && path === "/internal/v1/plugins/invoke") return invoke(request, env);
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
