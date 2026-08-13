import { createRequestDigest, verifyExecutionLease } from "@opap/approval";
import { discordCommandManifest, type DiscordCommandPolicy,
  type DiscordDisplayPolicy } from "@opap/discord-connector";
import { importJWK, type JWK } from "jose";

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN?: string;
  EXECUTION_LEASE_PUBLIC_JWK: string;
  DISCORD_DB: D1Database;
};

type ApiResult = { response: Response; uncertain: boolean };

const json = (value: unknown, status = 200): Response => Response.json(value, {
  status, headers: { "Cache-Control": "no-store" },
});

const objectBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await request.json().catch(() => undefined);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
};

const api = async (env: Bindings, path: string, init: RequestInit,
  authentication: "bot" | "webhook" = "bot"): Promise<ApiResult> => {
  if (authentication === "bot" && !env.DISCORD_BOT_TOKEN) {
    return { response: json({ code: "DISCORD_BOT_TOKEN_NOT_CONFIGURED" }, 503), uncertain: false };
  }
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "Open-Personal-Agent-Platform/0.1");
  if (authentication === "bot") headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN ?? ""}`);
  let response: Response;
  try {
    response = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers });
  } catch {
    return { response: json({ code: "DISCORD_WRITE_UNKNOWN" }, 409), uncertain: true };
  }
  if (response.status === 429) {
    const value: unknown = await response.clone().json().catch(() => ({}));
    const retryAfter = typeof value === "object" && value !== null &&
      typeof (value as Record<string, unknown>)["retry_after"] === "number"
      ? (value as Record<string, number>)["retry_after"] : 1;
    return { response: json({ code: "DISCORD_RATE_LIMITED", retryAfter }, 429), uncertain: false };
  }
  return { response, uncertain: false };
};

const syncCommands = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID) return json({ code: "INVALID_REQUEST" }, 400);
  const digest = await createRequestDigest(discordCommandManifest);
  const current = await env.DISCORD_DB.prepare(
    "SELECT manifest_digest FROM discord_command_manifests WHERE deployment_id = ?",
  ).bind(env.DEPLOYMENT_ID).first<{ manifest_digest: string }>();
  if (current?.manifest_digest === digest) return json({ status: "unchanged", manifestDigest: digest });
  const result = await api(env, `/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: "PUT", body: JSON.stringify(discordCommandManifest),
  });
  if (!result.response.ok) return new Response(result.response.body, result.response);
  const now = new Date().toISOString();
  await env.DISCORD_DB.prepare(
    `INSERT INTO discord_command_manifests (deployment_id, manifest_digest, synced_at)
     VALUES (?, ?, ?) ON CONFLICT (deployment_id) DO UPDATE SET
       manifest_digest = excluded.manifest_digest, synced_at = excluded.synced_at`,
  ).bind(env.DEPLOYMENT_ID, digest, now).run();
  return json({ status: "synchronized", manifestDigest: digest, synchronizedAt: now });
};

const updateInteraction = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    typeof body["interactionToken"] !== "string" || typeof body["content"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const payload: Record<string, unknown> = { content: body["content"], allowed_mentions: { parse: [] } };
  if (Array.isArray(body["components"])) payload["components"] = body["components"];
  const result = await api(env,
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(body["interactionToken"])}/messages/@original`,
    { method: "PATCH", body: JSON.stringify(payload) }, "webhook");
  return new Response(result.response.body, result.response);
};

const createDmDestination = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    typeof body["principalId"] !== "string" || typeof body["discordUserId"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const result = await api(env, "/users/@me/channels", {
    method: "POST", body: JSON.stringify({ recipient_id: body["discordUserId"] }),
  });
  const value: unknown = await result.response.clone().json().catch(() => ({}));
  if (!result.response.ok || typeof value !== "object" || value === null ||
    typeof (value as Record<string, unknown>)["id"] !== "string") {
    return new Response(result.response.body, result.response);
  }
  const channelId = (value as Record<string, string>)["id"] ?? "";
  const now = new Date().toISOString();
  const destinationId = `discord-destination:dm:${body["discordUserId"]}`;
  await env.DISCORD_DB.prepare(
    `INSERT INTO discord_destinations
     (deployment_id, destination_id, owner_principal_id, kind, discord_user_id,
      guild_id, channel_id, display_policy, command_policy, status, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, 'dm', ?, NULL, ?, 'metadata-only', 'dm-only', 'active', ?, ?, NULL)
     ON CONFLICT (deployment_id, destination_id) DO UPDATE SET
       owner_principal_id = excluded.owner_principal_id, channel_id = excluded.channel_id,
       status = 'active', updated_at = excluded.updated_at, revoked_at = NULL`,
  ).bind(env.DEPLOYMENT_ID, destinationId, body["principalId"], body["discordUserId"],
    channelId, now, now).run();
  return json({ destinationId, channelId, status: "active" }, 201);
};

const listDestinations = async (request: Request, env: Bindings): Promise<Response> => {
  const deploymentId = new URL(request.url).searchParams.get("deploymentId");
  if (deploymentId !== env.DEPLOYMENT_ID) return json({ code: "INVALID_REQUEST" }, 400);
  const result = await env.DISCORD_DB.prepare(
    `SELECT destination_id, kind, discord_user_id, guild_id, channel_id, display_policy,
            command_policy, status, created_at, updated_at
     FROM discord_destinations WHERE deployment_id = ? AND status = 'active' ORDER BY created_at`,
  ).bind(env.DEPLOYMENT_ID).all();
  return json({ destinations: result.results.map((row) => ({
    destinationId: row["destination_id"], kind: row["kind"],
    discordUserId: row["discord_user_id"], guildId: row["guild_id"], channelId: row["channel_id"],
    displayPolicy: row["display_policy"], commandPolicy: row["command_policy"],
    status: row["status"], createdAt: row["created_at"], updatedAt: row["updated_at"],
  })) });
};

const revokeDestination = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    typeof body["destinationId"] !== "string" || typeof body["principalId"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const now = new Date().toISOString();
  const result = await env.DISCORD_DB.prepare(
    `UPDATE discord_destinations SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE deployment_id = ? AND destination_id = ? AND owner_principal_id = ? AND status = 'active'`,
  ).bind(now, now, env.DEPLOYMENT_ID, body["destinationId"], body["principalId"]).run();
  return result.meta.changes === 1 ? new Response(null, { status: 204 })
    : json({ code: "DISCORD_DESTINATION_NOT_FOUND" }, 404);
};

const destinationInput = (value: unknown): { guildId: string; channelId: string;
  displayPolicy: DiscordDisplayPolicy; commandPolicy: DiscordCommandPolicy } | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const displayPolicy = input["displayPolicy"];
  const commandPolicy = input["commandPolicy"];
  if (typeof input["guildId"] !== "string" || typeof input["channelId"] !== "string" ||
    (displayPolicy !== "metadata-only" && displayPolicy !== "full-preview") ||
    (commandPolicy !== "approved-only" && commandPolicy !== "owner-any" && commandPolicy !== "dm-only")) {
    return undefined;
  }
  return { guildId: input["guildId"], channelId: input["channelId"], displayPolicy, commandPolicy };
};

const execute = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID || typeof body["principalId"] !== "string" ||
    typeof body["capabilityId"] !== "string" || typeof body["lease"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const input = destinationInput(body["input"]);
  if (!input || (body["capabilityId"] !== "discord.notification-destinations.configure" &&
    body["capabilityId"] !== "discord.notification-policy.update")) {
    return json({ code: "INVALID_CAPABILITY_INPUT" }, 400);
  }
  const keyValue: unknown = JSON.parse(env.EXECUTION_LEASE_PUBLIC_JWK);
  if (typeof keyValue !== "object" || keyValue === null || Array.isArray(keyValue)) {
    return json({ code: "LEASE_KEY_INVALID" }, 503);
  }
  const claims = await verifyExecutionLease(body["lease"], await importJWK(keyValue as JWK, "EdDSA"), {
    issuer: `control:${env.DEPLOYMENT_ID}`, principalId: body["principalId"],
    capabilityId: body["capabilityId"], gatekeeperId: "gatekeeper:discord", request: input,
  });
  if (!claims.approvalId) return json({ code: "APPROVAL_REQUIRED" }, 403);
  const consumed = await env.DISCORD_DB.prepare(
    `INSERT OR IGNORE INTO discord_execution_nonces
     (deployment_id, nonce, capability_id, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(env.DEPLOYMENT_ID, claims.jti, body["capabilityId"],
    new Date(claims.exp * 1_000).toISOString(), new Date().toISOString()).run();
  if (consumed.meta.changes !== 1) return json({ code: "EXECUTION_LEASE_REPLAY" }, 409);
  const destinationId = `discord-destination:guild:${input.guildId}:${input.channelId}`;
  const now = new Date().toISOString();
  await env.DISCORD_DB.prepare(
    `INSERT INTO discord_destinations
     (deployment_id, destination_id, owner_principal_id, kind, discord_user_id, guild_id,
      channel_id, display_policy, command_policy, status, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, 'guild-channel', NULL, ?, ?, ?, ?, 'active', ?, ?, NULL)
     ON CONFLICT (deployment_id, destination_id) DO UPDATE SET
       display_policy = excluded.display_policy, command_policy = excluded.command_policy,
       status = 'active', updated_at = excluded.updated_at, revoked_at = NULL`,
  ).bind(env.DEPLOYMENT_ID, destinationId, body["principalId"], input.guildId, input.channelId,
    input.displayPolicy, input.commandPolicy, now, now).run();
  const confirmation = await api(env, `/channels/${input.channelId}/messages`, {
    method: "POST", body: JSON.stringify({
      content: "Open Personal Agent notifications are enabled for this channel.",
      allowed_mentions: { parse: [] },
    }),
  });
  if (!confirmation.response.ok) {
    return json({ code: confirmation.uncertain ? "DISCORD_WRITE_UNKNOWN" : "DISCORD_DELIVERY_FAILED" },
      confirmation.uncertain ? 409 : 502);
  }
  return json({ status: "succeeded", destinationId });
};

const deliver = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID || typeof body["content"] !== "string" ||
    typeof body["capabilityId"] !== "string") return json({ code: "INVALID_REQUEST" }, 400);
  if (body["sensitivity"] === "secret") return json({ code: "SECRET_DESTINATION_DENIED" }, 403);
  const result = await env.DISCORD_DB.prepare(
    `SELECT destination_id, channel_id, display_policy FROM discord_destinations
     WHERE deployment_id = ? AND status = 'active'`,
  ).bind(env.DEPLOYMENT_ID).all<{ destination_id: string; channel_id: string; display_policy: string }>();
  const outcomes = [];
  for (const destination of result.results) {
    const content = destination.display_policy === "full-preview" && body["destinationAllowed"] === true
      ? body["content"] : `Approval pending: ${body["capabilityId"]}`;
    const sent = await api(env, `/channels/${destination.channel_id}/messages`, {
      method: "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] },
        components: body["reviewCustomId"] ? [{ type: 1, components: [{ type: 2, style: 2,
          label: "Review", custom_id: body["reviewCustomId"] }] }] : [] }),
    });
    if (!sent.response.ok && !sent.uncertain) {
      const retryAfter = sent.response.status === 429
        ? Number((await sent.response.clone().json().catch(() => ({})) as Record<string, unknown>)["retryAfter"] ?? 1)
        : 60;
      await env.DISCORD_DB.prepare(
        `INSERT INTO discord_notification_outbox
         (deployment_id, outbox_id, destination_id, payload_json, attempt_count, not_before,
          status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'pending', ?, ?)`,
      ).bind(env.DEPLOYMENT_ID, `outbox:${crypto.randomUUID()}`, destination.destination_id,
        JSON.stringify({ content, reviewCustomId: body["reviewCustomId"] }),
        new Date(Date.now() + retryAfter * 1_000).toISOString(), new Date().toISOString(),
        new Date().toISOString()).run();
    }
    outcomes.push({ destinationId: destination.destination_id,
      status: sent.response.ok ? "succeeded" : sent.uncertain ? "unknown" : "queued" });
  }
  return json({ outcomes });
};

const replyToDm = async (request: Request, env: Bindings): Promise<Response> => {
  const body = await objectBody(request);
  if (!body || body["deploymentId"] !== env.DEPLOYMENT_ID ||
    typeof body["discordUserId"] !== "string" || typeof body["content"] !== "string") {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  const destination = await env.DISCORD_DB.prepare(
    `SELECT channel_id FROM discord_destinations
     WHERE deployment_id = ? AND discord_user_id = ? AND kind = 'dm' AND status = 'active'`,
  ).bind(env.DEPLOYMENT_ID, body["discordUserId"]).first<{ channel_id: string }>();
  if (!destination) return json({ code: "DISCORD_DM_DESTINATION_NOT_FOUND" }, 404);
  const sent = await api(env, `/channels/${destination.channel_id}/messages`, {
    method: "POST", body: JSON.stringify({ content: body["content"], allowed_mentions: { parse: [] } }),
  });
  return new Response(sent.response.body, sent.response);
};

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/internal/v1/health") {
      return json({ service: "discord-gatekeeper", status: "ok", botTokenConfigured: Boolean(env.DISCORD_BOT_TOKEN) });
    }
    if (request.method === "POST" && path === "/internal/v1/commands/sync") return syncCommands(request, env);
    if (request.method === "POST" && path === "/internal/v1/interactions/update") return updateInteraction(request, env);
    if (request.method === "POST" && path === "/internal/v1/destinations/dm") return createDmDestination(request, env);
    if (request.method === "GET" && path === "/internal/v1/destinations") return listDestinations(request, env);
    if (request.method === "DELETE" && path === "/internal/v1/destinations") return revokeDestination(request, env);
    if (request.method === "POST" && path === "/internal/v1/execute") return execute(request, env);
    if (request.method === "POST" && path === "/internal/v1/notifications/deliver") return deliver(request, env);
    if (request.method === "POST" && path === "/internal/v1/notifications/reply-dm") return replyToDm(request, env);
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;
