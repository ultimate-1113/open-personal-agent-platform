import {
  flattenCommandOptions,
  verifyBridgeSignature,
  verifyDiscordInteraction,
  type DiscordAssistantRequest,
  type DiscordAssistantResponse,
  type DiscordInteraction,
} from "@opap/discord-connector";
import { DurableObject } from "cloudflare:workers";

type AssistantRpc = {
  handleDiscord(input: DiscordAssistantRequest): Promise<DiscordAssistantResponse>;
  handleDiscordGateway(input: {
    gatewayMessageId: string;
    discordUserId: string;
    displayName?: string;
    content: string;
  }): Promise<DiscordAssistantResponse>;
};

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BRIDGE_SIGNING_KEY?: string;
  ASSISTANT: AssistantRpc;
  DISCORD_GATEKEEPER: Fetcher;
  DISCORD_DEDUPE: DurableObjectNamespace;
};

const MAX_BODY_BYTES = 64 * 1024;
const json = (value: unknown, status = 200): Response => Response.json(value, {
  status, headers: { "Cache-Control": "no-store" },
});

const sha256 = async (body: Uint8Array): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body).buffer)),
).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const readBody = async (request: Request): Promise<Uint8Array | undefined> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length <= MAX_BODY_BYTES ? body : undefined;
};

const claim = async (env: Bindings, key: string): Promise<boolean> => {
  const stub = env.DISCORD_DEDUPE.get(env.DISCORD_DEDUPE.idFromName(env.DEPLOYMENT_ID));
  const response = await stub.fetch("https://dedupe.internal/claim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
  });
  const value: unknown = await response.json().catch(() => ({}));
  return response.ok && typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["claimed"] === true;
};

export const didInsertDedupeKey = (rowsWritten: number): boolean => rowsWritten > 0;

export const discordResponseFlags = (guildId?: string): { flags: 64 } | Record<string, never> =>
  guildId ? { flags: 64 } : {};

const interactionUser = (interaction: DiscordInteraction) => interaction.user ?? interaction.member?.user;

const updateInteraction = async (env: Bindings, token: string,
  result: DiscordAssistantResponse): Promise<void> => {
  await env.DISCORD_GATEKEEPER.fetch(
    "https://discord-gatekeeper.internal/internal/v1/interactions/update", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        deploymentId: env.DEPLOYMENT_ID, interactionToken: token,
        content: result.content.slice(0, 2_000), components: result.components ?? [],
      }),
    },
  );
};

const processInteraction = async (interaction: DiscordInteraction, env: Bindings): Promise<void> => {
  const user = interactionUser(interaction);
  if (!user) return updateInteraction(env, interaction.token, { content: "Discord user is unavailable." });
  const commandName = interaction.type === 3 ? "component" : interaction.data?.name;
  if (!commandName) return updateInteraction(env, interaction.token, { content: "Unsupported interaction." });
  try {
    const input: DiscordAssistantRequest = {
      interactionId: interaction.id,
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      commandName,
      options: flattenCommandOptions(interaction.data?.options),
      ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
      ...(interaction.channel_id ? { channelId: interaction.channel_id } : {}),
      ...(interaction.data?.custom_id ? { componentId: interaction.data.custom_id } : {}),
    };
    await updateInteraction(env, interaction.token, await env.ASSISTANT.handleDiscord(input));
  } catch {
    await updateInteraction(env, interaction.token, { content: "The request could not be completed." });
  }
};

const interactions = async (request: Request, env: Bindings, context: ExecutionContext): Promise<Response> => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return json({ code: "DISCORD_SIGNATURE_REQUIRED" }, 401);
  const body = await readBody(request);
  if (!body) return json({ code: "REQUEST_BODY_TOO_LARGE" }, 413);
  if (!await verifyDiscordInteraction({ publicKeyHex: env.DISCORD_PUBLIC_KEY,
    signatureHex: signature, timestamp, body })) {
    return json({ code: "DISCORD_SIGNATURE_INVALID" }, 401);
  }
  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(new TextDecoder().decode(body)) as DiscordInteraction;
  } catch {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  if (interaction.application_id !== env.DISCORD_APPLICATION_ID) {
    return json({ code: "DISCORD_APPLICATION_MISMATCH" }, 403);
  }
  if (interaction.type === 1) return json({ type: 1 });
  if (!interaction.id || !interaction.token) return json({ code: "INVALID_REQUEST" }, 400);
  if (!await claim(env, `interaction:${interaction.id}`)) {
    return json({ type: 4, data: {
      content: "This interaction was already processed.",
      ...discordResponseFlags(interaction.guild_id),
    } });
  }
  context.waitUntil(processInteraction(interaction, env));
  return json({ type: 5, data: discordResponseFlags(interaction.guild_id) });
};

type GatewayEvent = {
  messageId: string;
  discordUserId: string;
  displayName?: string;
  content: string;
};

const gatewayEvents = async (request: Request, env: Bindings, context: ExecutionContext): Promise<Response> => {
  if (!env.DISCORD_BRIDGE_SIGNING_KEY) return json({ code: "GATEWAY_BRIDGE_DISABLED" }, 503);
  const timestamp = request.headers.get("x-opap-timestamp");
  const nonce = request.headers.get("x-opap-nonce");
  const signature = request.headers.get("x-opap-signature");
  const declaredDigest = request.headers.get("x-opap-body-sha256");
  if (!timestamp || !nonce || !signature || !declaredDigest) return json({ code: "BRIDGE_SIGNATURE_REQUIRED" }, 401);
  const body = await readBody(request);
  if (!body) return json({ code: "REQUEST_BODY_TOO_LARGE" }, 413);
  const actualDigest = await sha256(body);
  if (actualDigest !== declaredDigest || !await verifyBridgeSignature({
    signingKey: env.DISCORD_BRIDGE_SIGNING_KEY, timestamp, nonce,
    bodyDigest: declaredDigest, signatureHex: signature,
  })) return json({ code: "BRIDGE_SIGNATURE_INVALID" }, 401);
  const event: GatewayEvent = JSON.parse(new TextDecoder().decode(body)) as GatewayEvent;
  if (!event.messageId || !event.discordUserId || !event.content || event.content.length > 32_768) {
    return json({ code: "INVALID_REQUEST" }, 400);
  }
  if (!await claim(env, `bridge-nonce:${nonce}`) || !await claim(env, `gateway-message:${event.messageId}`)) {
    return json({ status: "duplicate" });
  }
  context.waitUntil((async () => {
    const result = await env.ASSISTANT.handleDiscordGateway({ gatewayMessageId: event.messageId,
      discordUserId: event.discordUserId, content: event.content,
      ...(event.displayName ? { displayName: event.displayName } : {}) });
    await env.DISCORD_GATEKEEPER.fetch(
      "https://discord-gatekeeper.internal/internal/v1/notifications/reply-dm", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          deploymentId: env.DEPLOYMENT_ID, discordUserId: event.discordUserId,
          content: result.content.slice(0, 2_000),
        }),
      },
    );
  })());
  return json({ status: "accepted" }, 202);
};

export class DiscordDedupe extends DurableObject<Bindings> {
  constructor(state: DurableObjectState, env: Bindings) {
    super(state, env);
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS seen (
      key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS seen_expiry ON seen (expires_at);`);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") {
      return new Response("Not Found", { status: 404 });
    }
    const value: unknown = await request.json().catch(() => null);
    const key = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["key"] : undefined;
    if (typeof key !== "string" || key.length > 300) return json({ code: "INVALID_REQUEST" }, 400);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM seen WHERE expires_at <= ?", now);
    const result = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO seen (key, expires_at) VALUES (?, ?)", key, now + 86_400_000,
    );
    await this.ctx.storage.setAlarm(now + 86_400_000);
    // rowsWritten includes index updates, so a successful insert can write more
    // than one row when the table has secondary indexes.
    return json({ claimed: didInsertDedupeKey(result.rowsWritten) });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM seen WHERE expires_at <= ?", now);
    const next = [...this.ctx.storage.sql.exec<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM seen",
    )][0]?.expires_at;
    if (typeof next === "number") await this.ctx.storage.setAlarm(next);
  }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return json({ service: "discord-adapter", status: "ok", gatewayBridge: env.DISCORD_BRIDGE_SIGNING_KEY ? "enabled" : "disabled" });
    }
    if (request.method === "POST" && path === "/interactions") return interactions(request, env, context);
    if (request.method === "POST" && path === "/gateway-events") return gatewayEvents(request, env, context);
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<Bindings>;
