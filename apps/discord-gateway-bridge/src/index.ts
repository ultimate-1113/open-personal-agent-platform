import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createBridgeSignature } from "@opap/discord-connector";

type GatewayPayload = { op: number; d: unknown; s?: number | null; t?: string | null };
type SessionState = { sessionId?: string; resumeGatewayUrl?: string; sequence?: number };

const token = process.env["DISCORD_BOT_TOKEN"];
const adapterUrl = process.env["DISCORD_ADAPTER_URL"];
const signingKey = process.env["DISCORD_BRIDGE_SIGNING_KEY"];
const statePath = process.env["DISCORD_BRIDGE_STATE_PATH"] ?? ".discord-gateway-session.json";
const healthPort = Number(process.env["DISCORD_BRIDGE_HEALTH_PORT"] ?? "9464");
if (!token || !adapterUrl || !signingKey) {
  throw new Error("DISCORD_BOT_TOKEN, DISCORD_ADAPTER_URL, and DISCORD_BRIDGE_SIGNING_KEY are required");
}

let ready = false;
let reconnects = 0;
let lastEventAt: string | undefined;
let stopping = false;
let session: SessionState = {};
const directMessageChannels = new Set<string>();

const loadState = async (): Promise<void> => {
  const value: unknown = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"));
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    session = {
      ...(typeof record["sessionId"] === "string" ? { sessionId: record["sessionId"] } : {}),
      ...(typeof record["resumeGatewayUrl"] === "string" ? { resumeGatewayUrl: record["resumeGatewayUrl"] } : {}),
      ...(typeof record["sequence"] === "number" ? { sequence: record["sequence"] } : {}),
    };
  }
};

const saveState = async (): Promise<void> => {
  await writeFile(statePath, JSON.stringify(session), { mode: 0o600 });
};

const forward = async (message: Record<string, unknown>): Promise<void> => {
  const author = typeof message["author"] === "object" && message["author"] !== null
    ? message["author"] as Record<string, unknown> : {};
  const channelId = message["channel_id"];
  const attachments = message["attachments"];
  if (typeof message["id"] !== "string" || typeof channelId !== "string" ||
    !directMessageChannels.has(channelId) || message["guild_id"] !== undefined ||
    typeof author["id"] !== "string" ||
    author["bot"] === true || typeof message["content"] !== "string" ||
    message["content"].length === 0 || (Array.isArray(attachments) && attachments.length > 0)) return;
  const body = JSON.stringify({
    messageId: message["id"], discordUserId: author["id"],
    displayName: typeof author["global_name"] === "string" ? author["global_name"] : author["username"],
    content: message["content"],
  });
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomUUID();
  const signature = await createBridgeSignature({ signingKey, timestamp, nonce, bodyDigest });
  const response = await fetch(new URL("/gateway-events", adapterUrl), {
    method: "POST", headers: { "Content-Type": "application/json", "X-OPAP-Timestamp": timestamp,
      "X-OPAP-Nonce": nonce, "X-OPAP-Body-SHA256": bodyDigest, "X-OPAP-Signature": signature },
    body,
  });
  if (!response.ok && response.status !== 409) throw new Error(`Adapter rejected gateway event: ${response.status}`);
};

const backoff = (attempt: number): number => Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)) +
  Math.floor(Math.random() * 1_000);

const connect = async (): Promise<void> => {
  const gateway = session.resumeGatewayUrl ?? "wss://gateway.discord.gg";
  const socket = new WebSocket(`${gateway}?v=10&encoding=json`);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatAcknowledged = true;
  let reconnectRequested = false;
  const send = (payload: unknown) => socket.send(JSON.stringify(payload));
  const close = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    ready = false;
  };
  await new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      void (async () => {
        const payload = JSON.parse(typeof event.data === "string" ? event.data :
          await (event.data as Blob).text()) as GatewayPayload;
        if (typeof payload.s === "number") {
          session.sequence = payload.s;
          await saveState();
        }
        if (payload.op === 10) {
          const hello = payload.d as { heartbeat_interval: number };
          heartbeatTimer = setInterval(() => {
            if (!heartbeatAcknowledged) {
              reconnectRequested = true;
              socket.close(4000, "Heartbeat was not acknowledged");
              return;
            }
            heartbeatAcknowledged = false;
            send({ op: 1, d: session.sequence ?? null });
          }, hello.heartbeat_interval);
          if (session.sessionId && session.sequence !== undefined) {
            send({ op: 6, d: { token, session_id: session.sessionId, seq: session.sequence } });
          } else {
            send({ op: 2, d: { token, intents: 36_864,
              properties: { os: process.platform, browser: "opap", device: "opap" } } });
          }
          return;
        }
        if (payload.op === 11) heartbeatAcknowledged = true;
        if (payload.op === 7) {
          reconnectRequested = true;
          socket.close(4000, "Discord requested reconnect");
        }
        if (payload.op === 9) {
          if (payload.d !== true) session = {};
          await saveState();
          reconnectRequested = true;
          socket.close(4000, "Invalid session");
        }
        if (payload.op !== 0 || !payload.t || typeof payload.d !== "object" || payload.d === null) return;
        const data = payload.d as Record<string, unknown>;
        lastEventAt = new Date().toISOString();
        if (payload.t === "READY") {
          if (typeof data["session_id"] === "string") session.sessionId = data["session_id"];
          if (typeof data["resume_gateway_url"] === "string") session.resumeGatewayUrl = data["resume_gateway_url"];
          ready = true;
          reconnects = 0;
          directMessageChannels.clear();
          if (Array.isArray(data["private_channels"])) {
            for (const channel of data["private_channels"]) {
              if (typeof channel === "object" && channel !== null &&
                (channel as Record<string, unknown>)["type"] === 1 &&
                typeof (channel as Record<string, unknown>)["id"] === "string") {
                directMessageChannels.add(String((channel as Record<string, unknown>)["id"]));
              }
            }
          }
          await saveState();
        } else if (payload.t === "RESUMED") {
          ready = true;
          reconnects = 0;
        } else if (payload.t === "CHANNEL_CREATE" && data["type"] === 1 && typeof data["id"] === "string") {
          directMessageChannels.add(data["id"]);
        } else if (payload.t === "CHANNEL_DELETE" && typeof data["id"] === "string") {
          directMessageChannels.delete(data["id"]);
        } else if (payload.t === "MESSAGE_CREATE") {
          await forward(data);
        }
      })().catch(() => {
        reconnectRequested = true;
        socket.close(4000, "Gateway event processing failed");
      });
    });
    socket.addEventListener("close", () => { close(); resolve(); });
    socket.addEventListener("error", () => { reconnectRequested = true; socket.close(); });
  });
  if (!stopping) {
    reconnects += 1;
    await new Promise((resolve) => setTimeout(resolve, reconnectRequested ? backoff(reconnects) : 5_000));
  }
};

createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
    return;
  }
  response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ service: "discord-gateway-bridge", status: ready ? "ok" : "degraded",
    experimental: true, reconnects, ...(lastEventAt ? { lastEventAt } : {}) }));
}).listen(healthPort, "127.0.0.1");

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });
await loadState();
while (!stopping) await connect();
