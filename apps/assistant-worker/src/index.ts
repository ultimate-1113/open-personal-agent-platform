import { Hono, type MiddlewareHandler } from "hono";
import {
  cloudCostPolicySchema,
  ownerModelSettingsSchema,
  type CloudCostPolicy,
  type OwnerModelSettings,
  type UsageRecord,
  type JsonValue,
} from "@opap/contracts";
import { createRequestDigest } from "@opap/approval";
import { IdentityError, JwtVerifier } from "@opap/identity";
import { sha256Hex } from "@opap/security";
import {
  DEFAULT_WORKERS_AI_MODEL,
  MockLocalProvider,
  ModelRouter,
  ModelRoutingError,
  WorkersAiProvider,
  estimateWorkersAiNeurons,
  type ModelRequest,
  type ModelToolCall,
  type ModelToolDefinition,
  type WorkersAiBinding,
} from "@opap/model-router";
import {
  CostPolicyConflictError,
  PRICE_CATALOG,
  type CostPolicyRepository,
} from "@opap/cost-control";

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  OWNER_EMAIL: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  ACCESS_JWKS_URI: string;
  CONTROL: Fetcher;
  GOOGLE_GATEKEEPER: Fetcher;
  CONVERSATIONS: DurableObjectNamespace;
  OWNER_QUOTA: DurableObjectNamespace;
  AI?: WorkersAiBinding;
  WORKERS_AI_MODEL?: string;
  AI_GATEWAY_ID?: string;
  GMAIL_DRAFT_ALLOWED_RECIPIENTS?: string;
};

type AssistantEnv = {
  Bindings: Bindings;
  Variables: { ownerPrincipalId: string };
};

type OwnerAuthorization =
  | { outcome: "authorized"; principalId: string }
  | { outcome: "denied" }
  | { outcome: "unavailable" };

export type AssistantDependencies = {
  authorizeOwner(request: Request, bindings: Bindings): Promise<OwnerAuthorization>;
  costPolicies?: CostPolicyRepository;
  modelRouter?: ModelRouter;
  modelSettings?: ModelSettingsRepository;
  now?: () => Date;
};

export interface ModelSettingsRepository {
  get(): Promise<OwnerModelSettings>;
  update(
    settings: OwnerModelSettings,
    audit: {
      principalId: string;
      requestId: string;
      idempotencyKey: string;
    },
  ): Promise<OwnerModelSettings>;
}

class ControlCostPolicyRepository implements CostPolicyRepository {
  constructor(
    readonly control: Fetcher,
    readonly deploymentId: string,
  ) {}

  async get(): Promise<CloudCostPolicy> {
    const url = new URL("https://control.internal/internal/v1/settings/budgets");
    url.searchParams.set("deploymentId", this.deploymentId);
    const response = await this.control.fetch(url);
    if (!response.ok) throw new Error("Budget settings are unavailable");
    return cloudCostPolicySchema.parse(await response.json());
  }

  async update(
    policy: CloudCostPolicy,
    auditInput: Parameters<CostPolicyRepository["update"]>[1],
  ): Promise<CloudCostPolicy> {
    const url = new URL("https://control.internal/internal/v1/settings/budgets");
    url.searchParams.set("deploymentId", this.deploymentId);
    const response = await this.control.fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy, ...auditInput }),
    });
    if (response.status === 409) throw new CostPolicyConflictError();
    if (!response.ok) throw new Error("Budget update failed");
    return cloudCostPolicySchema.parse(await response.json());
  }

  usage(): Promise<readonly UsageRecord[]> {
    return Promise.resolve([]);
  }
}

class ControlModelSettingsRepository implements ModelSettingsRepository {
  constructor(
    readonly control: Fetcher,
    readonly deploymentId: string,
  ) {}

  async get(): Promise<OwnerModelSettings> {
    const url = new URL("https://control.internal/internal/v1/settings/providers");
    url.searchParams.set("deploymentId", this.deploymentId);
    const response = await this.control.fetch(url);
    if (!response.ok) throw new Error("Provider settings are unavailable");
    return ownerModelSettingsSchema.parse(await response.json());
  }

  async update(
    settings: OwnerModelSettings,
    audit: Parameters<ModelSettingsRepository["update"]>[1],
  ): Promise<OwnerModelSettings> {
    const url = new URL("https://control.internal/internal/v1/settings/providers");
    url.searchParams.set("deploymentId", this.deploymentId);
    const response = await this.control.fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, ...audit }),
    });
    if (!response.ok) throw new Error(response.status === 409
      ? "IDEMPOTENCY_CONFLICT"
      : "Provider settings update failed");
    return ownerModelSettingsSchema.parse(await response.json());
  }
}

const problem = (
  request: Request,
  status: 400 | 403 | 404 | 409 | 503,
  title: string,
) =>
  Response.json(
    {
      type: `https://opap.dev/problems/${title.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    },
    { status, headers: { "Content-Type": "application/problem+json" } },
  );

type OwnerReservation = {
  quota: DurableObjectStub;
  reservationId: string;
};

type ApiConnection = {
  connectionId: string;
  accountLabel?: string;
};

const googleConnectionCache = new Map<string, {
  expiresAt: number;
  connections: ApiConnection[];
}>();

const activeGoogleConnectionsForAgent = async (bindings: Bindings): Promise<ApiConnection[]> => {
  const cached = googleConnectionCache.get(bindings.DEPLOYMENT_ID);
  if (cached && cached.expiresAt > Date.now()) return cached.connections;
  const url = new URL("https://google-gatekeeper.internal/internal/v1/connections");
  url.searchParams.set("deploymentId", bindings.DEPLOYMENT_ID);
  const response = await bindings.GOOGLE_GATEKEEPER.fetch(url);
  if (!response.ok) return [];
  const value: unknown = await response.json();
  const rows = typeof value === "object" && value !== null &&
    Array.isArray((value as Record<string, unknown>)["connections"])
    ? (value as Record<string, unknown>)["connections"] as unknown[]
    : [];
  const connections = rows.flatMap((item): ApiConnection[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    return row["providerId"] === "google" && row["status"] === "active" &&
      typeof row["connectionId"] === "string"
      ? [{
          connectionId: row["connectionId"],
          ...(typeof row["accountLabel"] === "string" ? { accountLabel: row["accountLabel"] } : {}),
        }]
      : [];
  });
  googleConnectionCache.set(bindings.DEPLOYMENT_ID, {
    expiresAt: Date.now() + 60_000,
    connections,
  });
  return connections;
};

async function reserveOwnerOperation(input: {
  bindings: Bindings;
  principalId: string;
  idempotencyKey: string;
  now: Date;
}): Promise<OwnerReservation | "unavailable" | "limit" | "conflict"> {
  const reservationId = `reservation:${crypto.randomUUID()}`;
  const quota = input.bindings.OWNER_QUOTA.get(
    input.bindings.OWNER_QUOTA.idFromName("owner"),
  );
  const response = await quota.fetch("https://quota.internal/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "reserve",
      deploymentId: input.bindings.DEPLOYMENT_ID,
      reservationId,
      idempotencyKey: input.idempotencyKey,
      scopeId: input.principalId,
      resource: "owner-stateful-operation",
      amount: 1,
      period: input.now.toISOString().slice(0, 7),
      expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    }),
  }).catch(() => undefined);
  if (!response) return "unavailable";
  if (response.status === 429) return "limit";
  if (response.status === 409) return "conflict";
  return response.ok ? { quota, reservationId } : "unavailable";
}

const settleOwnerOperation = async (
  reservation: OwnerReservation,
  deploymentId: string,
): Promise<boolean> => (await reservation.quota.fetch("https://quota.internal/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "settle",
    deploymentId,
    reservationId: reservation.reservationId,
    actualAmount: 1,
  }),
})).ok;

const releaseReservation = async (
  reservation: OwnerReservation,
  deploymentId: string,
): Promise<void> => {
  await reservation.quota.fetch("https://quota.internal/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "release",
      deploymentId,
      reservationId: reservation.reservationId,
    }),
  }).catch(() => undefined);
};

type AiReservation = {
  quota: DurableObjectStub;
  reservationId: string;
  estimatedNeurons: number;
};

async function reserveAi(input: {
  bindings: Bindings;
  principalId: string;
  idempotencyKey: string;
  request: ModelRequest;
  policy: CloudCostPolicy;
  now: Date;
}): Promise<AiReservation | "unavailable" | "limit" | "conflict"> {
  const quota = input.bindings.OWNER_QUOTA.get(
    input.bindings.OWNER_QUOTA.idFromName("owner"),
  );
  const reservationId = `reservation:ai:${crypto.randomUUID()}`;
  const estimatedNeurons = estimateWorkersAiNeurons(input.request);
  const response = await quota.fetch("https://quota.internal/reserve-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "reserve-ai",
      deploymentId: input.bindings.DEPLOYMENT_ID,
      reservationId,
      idempotencyKey: input.idempotencyKey,
      scopeId: input.principalId,
      day: input.now.toISOString().slice(0, 10),
      month: input.now.toISOString().slice(0, 7),
      neurons: estimatedNeurons,
      monthlyOverageMicros: input.policy.ai.monthlyOverageUsd === null
        ? null
        : Math.round(input.policy.ai.monthlyOverageUsd * 1_000_000),
      expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    }),
  }).catch(() => undefined);
  if (!response) return "unavailable";
  if (response.status === 429) return "limit";
  if (response.status === 409) return "conflict";
  if (!response.ok) return "unavailable";
  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null ||
    (result as Record<string, unknown>)["status"] !== "active") {
    return "conflict";
  }
  return { quota, reservationId, estimatedNeurons };
}

const settleAi = async (
  reservation: AiReservation,
  deploymentId: string,
  actualNeurons: number,
): Promise<boolean> => (await reservation.quota.fetch("https://quota.internal/settle-ai", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "settle-ai",
    deploymentId,
    reservationId: reservation.reservationId,
    actualNeurons,
  }),
})).ok;

const releaseAi = async (
  reservation: AiReservation,
  deploymentId: string,
): Promise<void> => {
  await reservation.quota.fetch("https://quota.internal/release-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "release-ai",
      deploymentId,
      reservationId: reservation.reservationId,
    }),
  }).catch(() => undefined);
};

export function createAssistantApp(dependencies: AssistantDependencies) {
  const app = new Hono<AssistantEnv>();
  const costPolicies = (bindings: Bindings): CostPolicyRepository =>
    dependencies.costPolicies ??
    new ControlCostPolicyRepository(bindings.CONTROL, bindings.DEPLOYMENT_ID);
  const modelSettings = (bindings: Bindings): ModelSettingsRepository =>
    dependencies.modelSettings ??
    new ControlModelSettingsRepository(bindings.CONTROL, bindings.DEPLOYMENT_ID);

  app.get("/health", (context) =>
    context.json({ service: "assistant-worker", status: "ok" } as const),
  );

  app.use("/v1/settings/budgets", async (context, next) => {
    const authorization = await dependencies.authorizeOwner(context.req.raw, context.env);
    if (authorization.outcome === "unavailable") {
      return problem(context.req.raw, 503, "OWNER_AUTH_NOT_CONFIGURED");
    }
    if (authorization.outcome === "denied") {
      return problem(context.req.raw, 403, "OWNER_ACCESS_DENIED");
    }
    context.set("ownerPrincipalId", authorization.principalId);
    return next();
  });

  app.use("/v1/usage", async (context, next) => {
    const authorization = await dependencies.authorizeOwner(context.req.raw, context.env);
    if (authorization.outcome === "unavailable") {
      return problem(context.req.raw, 503, "OWNER_AUTH_NOT_CONFIGURED");
    }
    if (authorization.outcome === "denied") {
      return problem(context.req.raw, 403, "OWNER_ACCESS_DENIED");
    }
    context.set("ownerPrincipalId", authorization.principalId);
    return next();
  });

  app.use("/v1/settings/providers", async (context, next) => {
    const authorization = await dependencies.authorizeOwner(context.req.raw, context.env);
    if (authorization.outcome === "unavailable") {
      return problem(context.req.raw, 503, "OWNER_AUTH_NOT_CONFIGURED");
    }
    if (authorization.outcome === "denied") {
      return problem(context.req.raw, 403, "OWNER_ACCESS_DENIED");
    }
    context.set("ownerPrincipalId", authorization.principalId);
    return next();
  });

  const authorizeConversation: MiddlewareHandler<AssistantEnv> = async (context, next) => {
    const authorization = await dependencies.authorizeOwner(context.req.raw, context.env);
    if (authorization.outcome === "unavailable") {
      return problem(context.req.raw, 503, "OWNER_AUTH_NOT_CONFIGURED");
    }
    if (authorization.outcome === "denied") {
      return problem(context.req.raw, 403, "OWNER_ACCESS_DENIED");
    }
    context.set("ownerPrincipalId", authorization.principalId);
    return next();
  };
  app.use("/v1/conversations", authorizeConversation);
  app.use("/v1/conversations/*", authorizeConversation);
  for (const route of ["/v1/tasks", "/v1/memories", "/v1/approvals", "/v1/audit"]) {
    app.use(route, authorizeConversation);
    app.use(`${route}/*`, authorizeConversation);
  }
  app.use("/v1/connections", authorizeConversation);
  app.use("/v1/connections/*", authorizeConversation);
  app.use("/v1/google", authorizeConversation);
  app.use("/v1/google/*", authorizeConversation);

  app.get("/v1/connections", async (context) => {
    const url = new URL("https://google-gatekeeper.internal/internal/v1/connections");
    url.searchParams.set("deploymentId", context.env.DEPLOYMENT_ID);
    const response = await context.env.GOOGLE_GATEKEEPER.fetch(url);
    return new Response(response.body, response);
  });

  app.post("/v1/connections/google/start", async (context) => {
    const requestUrl = new URL(context.req.url);
    const redirectUri = new URL("/v1/connections/google/callback", requestUrl.origin).toString();
    const response = await context.env.GOOGLE_GATEKEEPER.fetch(
      "https://google-gatekeeper.internal/internal/v1/oauth/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId: context.env.DEPLOYMENT_ID, redirectUri }),
      },
    );
    return new Response(response.body, response);
  });

  app.get("/v1/connections/google/callback", async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    if (!state || !code) return problem(context.req.raw, 400, "OAUTH_CALLBACK_INVALID");
    const response = await context.env.GOOGLE_GATEKEEPER.fetch(
      "https://google-gatekeeper.internal/internal/v1/oauth/callback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: context.env.DEPLOYMENT_ID,
          principalId: context.get("ownerPrincipalId"),
          state,
          code,
        }),
      },
    );
    if (!response.ok) return new Response(response.body, response);
    googleConnectionCache.delete(context.env.DEPLOYMENT_ID);
    return context.redirect("/?connection=google&status=connected", 302);
  });

  app.delete("/v1/connections/:connectionId", async (context) => {
    const response = await context.env.GOOGLE_GATEKEEPER.fetch(
      "https://google-gatekeeper.internal/internal/v1/connections",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: context.env.DEPLOYMENT_ID,
          connectionId: context.req.param("connectionId"),
        }),
      },
    );
    if (response.ok) googleConnectionCache.delete(context.env.DEPLOYMENT_ID);
    return new Response(response.body, response);
  });

  const forwardGoogleRead = async (
    context: Parameters<MiddlewareHandler<AssistantEnv>>[0],
    internalPath: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> => {
    const value: unknown = await context.req.json().catch(() => ({}));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const response = await context.env.GOOGLE_GATEKEEPER.fetch(
      `https://google-gatekeeper.internal${internalPath}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(value as Record<string, unknown>),
          ...extra,
          deploymentId: context.env.DEPLOYMENT_ID,
          connectionId: context.req.param("connectionId"),
        }),
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  };

  app.post("/v1/google/:connectionId/gmail/search", (context) =>
    forwardGoogleRead(context, "/internal/v1/google/gmail/search"));
  app.post("/v1/google/:connectionId/gmail/messages/:messageId", (context) =>
    forwardGoogleRead(context, "/internal/v1/google/gmail/messages/get", {
      messageId: context.req.param("messageId"),
    }));
  app.post("/v1/google/:connectionId/calendar/events/search", (context) =>
    forwardGoogleRead(context, "/internal/v1/google/calendar/events/list"));
  app.post("/v1/google/:connectionId/drive/search", (context) =>
    forwardGoogleRead(context, "/internal/v1/google/drive/files/search"));

  const requestGoogleWriteApproval = async (
    context: Parameters<MiddlewareHandler<AssistantEnv>>[0],
    capabilityId: "google.gmail.drafts.create" | "google.calendar.events.create",
    operationRequest: Record<string, JsonValue>,
    preview: Record<string, JsonValue>,
  ): Promise<Response> => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const response = await context.env.CONTROL.fetch(
      "https://control.internal/internal/v1/approvals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: context.env.DEPLOYMENT_ID,
          principalId: context.get("ownerPrincipalId"),
          capabilityId,
          gatekeeperId: "gatekeeper:google-personal",
          taskId: `task:${crypto.randomUUID()}`,
          request: operationRequest,
          requestDigest: await createRequestDigest(operationRequest),
          preview,
          requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
          idempotencyKey,
        }),
      },
    );
    return new Response(response.body, response);
  };

  const googleAgentTools = (
    connections: readonly ApiConnection[],
    recipients: readonly string[],
  ): ModelToolDefinition[] => {
    const connectionIds = connections.map((connection) => connection.connectionId);
    const connectionProperty = {
      type: "string",
      enum: connectionIds,
      description: connections.map((connection) =>
        `${connection.connectionId}: ${connection.accountLabel ?? "Google account"}`).join("; "),
    };
    const tools: ModelToolDefinition[] = [
      {
        name: "google_gmail_search",
        description: "Search the owner's Gmail. Use Gmail search syntax in query.",
        parameters: {
          type: "object",
          properties: {
            connectionId: connectionProperty,
            query: { type: "string", description: "Gmail search query" },
          },
          required: ["connectionId", "query"],
        },
      },
      {
        name: "google_calendar_list_events",
        description: "List upcoming events from the owner's primary Google Calendar.",
        parameters: {
          type: "object",
          properties: {
            connectionId: connectionProperty,
            timeMin: { type: "string", description: "ISO 8601 lower bound" },
            timeMax: { type: "string", description: "Optional ISO 8601 upper bound" },
          },
          required: ["connectionId"],
        },
      },
      {
        name: "google_drive_search",
        description: "Search metadata for files in the owner's Google Drive.",
        parameters: {
          type: "object",
          properties: {
            connectionId: connectionProperty,
            query: { type: "string", description: "Google Drive files.list q expression" },
          },
          required: ["connectionId"],
        },
      },
      {
        name: "google_calendar_create_event",
        description: "Request approval to create an event on the owner's primary calendar. Does not invite attendees.",
        parameters: {
          type: "object",
          properties: {
            connectionId: connectionProperty,
            summary: { type: "string" },
            start: { type: "string", description: "ISO 8601 start time" },
            end: { type: "string", description: "ISO 8601 end time" },
            timeZone: { type: "string", description: "IANA time zone" },
          },
          required: ["connectionId", "summary", "start", "end"],
        },
      },
    ];
    if (recipients.length > 0) tools.push({
      name: "google_gmail_create_draft",
      description: "Request approval to create (not send) a Gmail draft to an allowed recipient.",
      parameters: {
        type: "object",
        properties: {
          connectionId: connectionProperty,
          to: { type: "string", enum: recipients },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["connectionId", "to", "subject", "body"],
      },
    });
    return tools;
  };

  const executeGoogleAgentTool = async (
    context: Parameters<MiddlewareHandler<AssistantEnv>>[0],
    call: ModelToolCall,
    connections: readonly ApiConnection[],
  ): Promise<string> => {
    const requestedConnection = call.arguments["connectionId"];
    const requested = typeof requestedConnection === "string"
      ? requestedConnection.trim().toLocaleLowerCase()
      : "";
    const matchedConnection = connections.find((connection) =>
      connection.connectionId.toLocaleLowerCase() === requested ||
      connection.accountLabel?.trim().toLocaleLowerCase() === requested
    ) ?? (connections.length === 1 ? connections[0] : undefined);
    if (!matchedConnection) {
      return "Google Toolを実行できませんでした: 使用するGoogleアカウントを指定してください。";
    }
    const connectionId = matchedConnection.connectionId;
    const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
    const googleFetch = async (path: string, input: Record<string, JsonValue>) => {
      const response = await context.env.GOOGLE_GATEKEEPER.fetch(
        `https://google-gatekeeper.internal${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input, deploymentId: context.env.DEPLOYMENT_ID, connectionId,
            principalId: context.get("ownerPrincipalId"), requestId,
          }),
        },
      );
      const value: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`GOOGLE_TOOL_FAILED_${response.status}`);
      return value;
    };
    if (call.name === "google_gmail_search") {
      const query = call.arguments["query"];
      if (typeof query !== "string") return "Gmail検索条件が不正です。";
      const value = await googleFetch("/internal/v1/google/gmail/search", {
        query, maxResults: 10,
      });
      return `Gmail検索結果（モデルへ再送していません）:\n${JSON.stringify(value, null, 2)}`;
    }
    if (call.name === "google_calendar_list_events") {
      const input: Record<string, JsonValue> = { maxResults: 10 };
      if (typeof call.arguments["timeMin"] === "string") input["timeMin"] = call.arguments["timeMin"];
      if (typeof call.arguments["timeMax"] === "string") input["timeMax"] = call.arguments["timeMax"];
      const value = await googleFetch("/internal/v1/google/calendar/events/list", input);
      return `Calendar取得結果（モデルへ再送していません）:\n${JSON.stringify(value, null, 2)}`;
    }
    if (call.name === "google_drive_search") {
      const query = call.arguments["query"];
      const value = await googleFetch("/internal/v1/google/drive/files/search", {
        ...(typeof query === "string" ? { query } : {}), pageSize: 10,
      });
      return `Drive検索結果（モデルへ再送していません）:\n${JSON.stringify(value, null, 2)}`;
    }
    if (call.name === "google_gmail_create_draft") {
      const to = call.arguments["to"];
      const subject = call.arguments["subject"];
      const body = call.arguments["body"];
      if (typeof to !== "string" || typeof subject !== "string" || typeof body !== "string") {
        return "Gmail下書きの内容が不正です。";
      }
      const approval = await requestGoogleWriteApproval(context, "google.gmail.drafts.create", {
        connectionId, to, subject, body,
      }, {
        destination: to, operation: "Create Gmail draft", subject, bodyPreview: body.slice(0, 500),
      });
      const value: unknown = await approval.json().catch(() => ({}));
      if (!approval.ok) throw new Error(`APPROVAL_REQUEST_FAILED_${approval.status}`);
      const approvalId = typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)["approvalId"] : undefined;
      return `Gmail下書きの作成は承認待ちです。承認画面で確認してください。${typeof approvalId === "string" ? ` (${approvalId})` : ""}`;
    }
    if (call.name === "google_calendar_create_event") {
      const summary = call.arguments["summary"];
      const start = call.arguments["start"];
      const end = call.arguments["end"];
      if (typeof summary !== "string" || typeof start !== "string" || typeof end !== "string") {
        return "Calendar予定の内容が不正です。";
      }
      const operation: Record<string, JsonValue> = { connectionId, summary, start, end };
      if (typeof call.arguments["timeZone"] === "string") operation["timeZone"] = call.arguments["timeZone"];
      const approval = await requestGoogleWriteApproval(context, "google.calendar.events.create", operation, {
        destination: "Google Calendar", operation: "Create calendar event", summary, start, end,
      });
      const value: unknown = await approval.json().catch(() => ({}));
      if (!approval.ok) throw new Error(`APPROVAL_REQUEST_FAILED_${approval.status}`);
      const approvalId = typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)["approvalId"] : undefined;
      return `Calendar予定の作成は承認待ちです。承認画面で確認してください。${typeof approvalId === "string" ? ` (${approvalId})` : ""}`;
    }
    return "要求されたToolは利用できません。";
  };

  app.post("/v1/google/:connectionId/gmail/drafts", async (context) => {
    const value: unknown = await context.req.json().catch(() => null);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const body = value as Record<string, unknown>;
    const recipients = new Set((context.env.GMAIL_DRAFT_ALLOWED_RECIPIENTS ?? "")
      .split(",").map((recipient) => recipient.trim().toLowerCase()).filter(Boolean));
    if (typeof body["to"] !== "string" || !recipients.has(body["to"].toLowerCase()) ||
      typeof body["subject"] !== "string" || body["subject"].length > 998 ||
      typeof body["body"] !== "string" || body["body"].length > 65_536) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const operationRequest = {
      connectionId: context.req.param("connectionId"),
      to: body["to"], subject: body["subject"], body: body["body"],
    };
    return requestGoogleWriteApproval(context, "google.gmail.drafts.create", operationRequest, {
      destination: body["to"], operation: "Create Gmail draft",
      subject: body["subject"], bodyPreview: body["body"].slice(0, 500),
    });
  });

  app.post("/v1/google/:connectionId/calendar/events", async (context) => {
    const value: unknown = await context.req.json().catch(() => null);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const body = value as Record<string, unknown>;
    if (typeof body["summary"] !== "string" || body["summary"].length > 1_000 ||
      typeof body["start"] !== "string" || Number.isNaN(Date.parse(body["start"])) ||
      typeof body["end"] !== "string" || Number.isNaN(Date.parse(body["end"])) ||
      Date.parse(body["end"]) <= Date.parse(body["start"]) ||
      (body["description"] !== undefined && typeof body["description"] !== "string") ||
      (body["timeZone"] !== undefined && typeof body["timeZone"] !== "string")) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const operationRequest: Record<string, JsonValue> = {
      connectionId: context.req.param("connectionId"), summary: body["summary"],
      start: body["start"], end: body["end"],
      ...(typeof body["description"] === "string" ? { description: body["description"] } : {}),
      ...(typeof body["timeZone"] === "string" ? { timeZone: body["timeZone"] } : {}),
    };
    return requestGoogleWriteApproval(context, "google.calendar.events.create", operationRequest, {
      destination: "Google Calendar", operation: "Create calendar event",
      summary: body["summary"], start: body["start"], end: body["end"],
    });
  });

  app.get("/v1/settings/budgets", async (context) =>
    context.json({
      ...await costPolicies(context.env).get(),
      pricingCatalogVerifiedAt: PRICE_CATALOG.verifiedAt,
    }),
  );

  app.patch("/v1/settings/budgets", async (context) => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const parsed = cloudCostPolicySchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return problem(context.req.raw, 400, "INVALID_BUDGET_POLICY");
    const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
    const ownerPrincipalId = context.get("ownerPrincipalId");
    try {
      const updated = await costPolicies(context.env).update(parsed.data, {
        principalId: ownerPrincipalId,
        requestId,
        idempotencyKey,
        occurredAt: (dependencies.now?.() ?? new Date()).toISOString(),
      });
      return context.json(updated);
    } catch (error) {
      if (error instanceof CostPolicyConflictError) {
        return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
      }
      throw error;
    }
  });

  app.get("/v1/settings/providers", async (context) =>
    context.json(await modelSettings(context.env).get()),
  );

  app.patch("/v1/settings/providers", async (context) => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const parsed = ownerModelSettingsSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return problem(context.req.raw, 400, "INVALID_PROVIDER_SETTINGS");
    try {
      return context.json(await modelSettings(context.env).update(parsed.data, {
        principalId: context.get("ownerPrincipalId"),
        requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
        idempotencyKey,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
        return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
      }
      throw error;
    }
  });

  app.get("/v1/usage", async (context) => {
    const period = context.req.query("period");
    if (period !== "current-billing-cycle") {
      return problem(context.req.raw, 400, "INVALID_USAGE_PERIOD");
    }
    const currentPeriod = (dependencies.now?.() ?? new Date())
      .toISOString()
      .slice(0, 7);
    const quota = context.env.OWNER_QUOTA.get(context.env.OWNER_QUOTA.idFromName("owner"));
    const url = new URL("https://quota.internal/usage");
    url.searchParams.set("deploymentId", context.env.DEPLOYMENT_ID);
    url.searchParams.set("scopeId", context.get("ownerPrincipalId"));
    url.searchParams.set("period", currentPeriod);
    const response = await quota.fetch(url).catch(() => undefined);
    if (!response?.ok) return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    const usage: unknown = await response.json();
    const usageRecord = typeof usage === "object" && usage !== null
      ? usage as Record<string, unknown>
      : {};
    const resources = usageRecord["resources"] ?? [];
    return context.json({
      period,
      currentPeriod,
      resources,
      ai: usageRecord["ai"] ?? null,
    });
  });

  app.post("/v1/conversations", async (context) => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const value: unknown = await context.req.json().catch(() => ({}));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const content = (value as Record<string, unknown>)["content"];
    if (content !== undefined && (typeof content !== "string" || content.length > 32_768)) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const principalId = context.get("ownerPrincipalId");
    const digest = await sha256Hex(`${context.env.DEPLOYMENT_ID}\u0000${idempotencyKey}`);
    const conversationId = `conversation:${digest}`;
    const now = dependencies.now?.() ?? new Date();
    const reservation = await reserveOwnerOperation({
      bindings: context.env,
      principalId,
      idempotencyKey: `conversation:${idempotencyKey}`,
      now,
    });
    if (reservation === "limit") return problem(context.req.raw, 403, "BUDGET_HARD_LIMIT_REACHED");
    if (reservation === "conflict") return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
    if (reservation === "unavailable") return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    const conversation = context.env.CONVERSATIONS.get(
      context.env.CONVERSATIONS.idFromName(conversationId),
    );
    let created: Response;
    try {
      created = await conversation.fetch("https://conversation.internal/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          principalId,
          idempotencyKey,
          ...(content === undefined ? {} : { content }),
        }),
      });
    } catch {
      await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
      return problem(context.req.raw, 503, "CONVERSATION_UNAVAILABLE");
    }
    if (!created.ok) {
      await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
      return new Response(created.body, created);
    }
    if (!await settleOwnerOperation(reservation, context.env.DEPLOYMENT_ID)) {
      return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    }
    return new Response(created.body, {
      status: created.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  });

  app.get("/v1/conversations/:conversationId", async (context) => {
    const conversationId = context.req.param("conversationId");
    if (!/^conversation:[a-f0-9]{64}$/u.test(conversationId)) {
      return problem(context.req.raw, 404, "NOT_FOUND");
    }
    const conversation = context.env.CONVERSATIONS.get(
      context.env.CONVERSATIONS.idFromName(conversationId),
    );
    const response = await conversation.fetch("https://conversation.internal/state");
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  });

  app.post("/v1/conversations/:conversationId/messages", async (context) => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const value: unknown = await context.req.json().catch(() => null);
    const content = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["content"]
      : undefined;
    if (typeof content !== "string" || content.length === 0 || content.length > 32_768) {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const conversationId = context.req.param("conversationId");
    if (!/^conversation:[a-f0-9]{64}$/u.test(conversationId)) {
      return problem(context.req.raw, 404, "NOT_FOUND");
    }
    const principalId = context.get("ownerPrincipalId");
    const stub = context.env.CONVERSATIONS.get(
      context.env.CONVERSATIONS.idFromName(conversationId),
    );
    const replayUrl = new URL("https://conversation.internal/exchange/replay");
    replayUrl.searchParams.set("idempotencyKey", idempotencyKey);
    const replay = await stub.fetch(replayUrl);
    if (replay.ok) return new Response(replay.body, replay);
    if (replay.status !== 404) return new Response(replay.body, replay);

    let activeProviderId: "provider:mock-local" | "provider:workers-ai";
    let router: ModelRouter;
    let destinationAllowed: boolean;
    if (dependencies.modelRouter) {
      activeProviderId = "provider:mock-local";
      router = dependencies.modelRouter;
      destinationAllowed = true;
    } else {
      let settings: OwnerModelSettings;
      try {
        settings = await modelSettings(context.env).get();
      } catch {
        return problem(context.req.raw, 503, "MODEL_SETTINGS_UNAVAILABLE");
      }
      const active = settings.providers.find((provider) => provider.enabled);
      if (!active) return problem(context.req.raw, 503, "MODEL_SETTINGS_UNAVAILABLE");
      activeProviderId = active.providerId;
      destinationAllowed = active.allowedVisibilities.includes("owner") &&
        active.allowedSensitivities.includes("normal");
      if (activeProviderId === "provider:workers-ai") {
        if (!context.env.AI || !context.env.AI_GATEWAY_ID) {
          return problem(context.req.raw, 503, "MODEL_PROVIDER_NOT_CONFIGURED");
        }
        router = new ModelRouter([new WorkersAiProvider(
          context.env.AI,
          context.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
          context.env.AI_GATEWAY_ID,
        )]);
      } else {
        router = new ModelRouter([new MockLocalProvider()]);
      }
    }
    if (!destinationAllowed) {
      return problem(context.req.raw, 403, "MODEL_DESTINATION_DENIED");
    }
    const googleConnections = await activeGoogleConnectionsForAgent(context.env).catch(() => []);
    const recipients = (context.env.GMAIL_DRAFT_ALLOWED_RECIPIENTS ?? "")
      .split(",").map((recipient) => recipient.trim()).filter(Boolean);
    const tools = googleConnections.length > 0
      ? googleAgentTools(googleConnections, recipients)
      : [];
    const modelRequest: ModelRequest = {
      messages: [
        ...(tools.length > 0
          ? [{
              role: "system" as const,
              content: "You are the owner's personal agent. Use an available Google tool when the request requires Gmail, Calendar, or Drive. Never claim a write completed when it only requested approval.",
            }]
          : []),
        { role: "user", content },
      ],
      informationPolicy: {
        deploymentId: context.env.DEPLOYMENT_ID,
        subjectPrincipalIds: [principalId],
        visibility: "owner",
        sensitivity: "normal",
        trust: "trusted",
        allowedAudienceIds: [principalId],
        allowedDestinationIds: [activeProviderId],
        retention: { mode: "until-deleted" },
      },
      audience: "owner",
      ...(tools.length > 0 ? { tools } : {}),
    };
    const now = dependencies.now?.() ?? new Date();
    const reservation = await reserveOwnerOperation({
      bindings: context.env,
      principalId,
      idempotencyKey: `message:${idempotencyKey}`,
      now,
    });
    if (reservation === "limit") return problem(context.req.raw, 403, "BUDGET_HARD_LIMIT_REACHED");
    if (reservation === "conflict") return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
    if (reservation === "unavailable") return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    let aiReservation: AiReservation | undefined;
    if (activeProviderId === "provider:workers-ai") {
      let policy: CloudCostPolicy;
      try {
        policy = await costPolicies(context.env).get();
      } catch {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
      }
      const ai = await reserveAi({
        bindings: context.env,
        principalId,
        idempotencyKey: `ai-message:${idempotencyKey}`,
        request: modelRequest,
        policy,
        now,
      });
      if (ai === "limit") {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return problem(context.req.raw, 403, "AI_SPEND_LIMIT_REACHED");
      }
      if (ai === "conflict") {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
      }
      if (ai === "unavailable") {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
      }
      aiReservation = ai;
    }
    let generated;
    try {
      generated = await router.generate(modelRequest);
    } catch (error) {
      await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
      if (aiReservation) {
        if (error instanceof ModelRoutingError && error.code === "AI_SPEND_LIMIT_REACHED") {
          await releaseAi(aiReservation, context.env.DEPLOYMENT_ID);
        } else {
          // A transport failure can occur after inference was billed. Settle
          // the conservative reservation instead of silently undercounting.
          await settleAi(
            aiReservation,
            context.env.DEPLOYMENT_ID,
            aiReservation.estimatedNeurons,
          ).catch(() => false);
        }
      }
      return problem(
        context.req.raw,
        error instanceof ModelRoutingError &&
          (error.code === "MODEL_DESTINATION_DENIED" || error.code === "AI_SPEND_LIMIT_REACHED")
          ? 403
          : 503,
        error instanceof ModelRoutingError ? error.code : "MODEL_PROVIDER_FAILED",
      );
    }
    let assistantContent = generated.text;
    const billedModelOutput = generated.text || JSON.stringify(generated.toolCalls ?? []);
    if (generated.toolCalls?.length) {
      const outputs: string[] = [];
      let writeRequested = false;
      for (const call of generated.toolCalls.slice(0, 3)) {
        const isWrite = call.name === "google_gmail_create_draft" ||
          call.name === "google_calendar_create_event";
        if (isWrite && writeRequested) {
          outputs.push("同じメッセージ内の追加書込は安全のため処理しませんでした。");
          continue;
        }
        if (isWrite) writeRequested = true;
        try {
          outputs.push(await executeGoogleAgentTool(context, call, googleConnections));
        } catch {
          outputs.push(`Tool ${call.name} の実行に失敗しました。`);
        }
      }
      assistantContent = outputs.join("\n\n");
    }
    let response: Response;
    try {
      response = await stub.fetch("https://conversation.internal/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principalId,
          idempotencyKey,
          userContent: content,
          assistantContent,
          providerId: generated.providerId,
        }),
      });
    } catch {
      await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
      if (aiReservation) {
        await settleAi(
          aiReservation,
          context.env.DEPLOYMENT_ID,
          estimateWorkersAiNeurons(modelRequest, billedModelOutput),
        ).catch(() => false);
      }
      return problem(context.req.raw, 503, "CONVERSATION_UNAVAILABLE");
    }
    if (!response.ok) {
      await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
      if (aiReservation) {
        await settleAi(
          aiReservation,
          context.env.DEPLOYMENT_ID,
          estimateWorkersAiNeurons(modelRequest, billedModelOutput),
        ).catch(() => false);
      }
      return new Response(response.body, response);
    }
    if (aiReservation && !await settleAi(
      aiReservation,
      context.env.DEPLOYMENT_ID,
      estimateWorkersAiNeurons(modelRequest, billedModelOutput),
    )) {
      return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    }
    if (!await settleOwnerOperation(reservation, context.env.DEPLOYMENT_ID)) {
      return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
    }
    return new Response(response.body, response);
  });

  for (const resource of ["tasks", "memories"] as const) {
    app.get(`/v1/${resource}`, async (context) => {
      const conversationId = context.req.query("conversationId");
      if (!conversationId || !/^conversation:[a-f0-9]{64}$/u.test(conversationId)) {
        return problem(context.req.raw, 400, "CONVERSATION_ID_REQUIRED");
      }
      const stub = context.env.CONVERSATIONS.get(
        context.env.CONVERSATIONS.idFromName(conversationId),
      );
      const response = await stub.fetch(`https://conversation.internal/${resource}`);
      return new Response(response.body, response);
    });

    app.post(`/v1/${resource}`, async (context) => {
      const idempotencyKey = context.req.header("idempotency-key");
      if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
      const value: unknown = await context.req.json().catch(() => null);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return problem(context.req.raw, 400, "INVALID_REQUEST");
      }
      const body = value as Record<string, unknown>;
      const conversationId = body["conversationId"];
      if (typeof conversationId !== "string" || !/^conversation:[a-f0-9]{64}$/u.test(conversationId)) {
        return problem(context.req.raw, 400, "CONVERSATION_ID_REQUIRED");
      }
      const principalId = context.get("ownerPrincipalId");
      const reservation = await reserveOwnerOperation({
        bindings: context.env,
        principalId,
        idempotencyKey: `${resource}:${idempotencyKey}`,
        now: dependencies.now?.() ?? new Date(),
      });
      if (reservation === "limit") return problem(context.req.raw, 403, "BUDGET_HARD_LIMIT_REACHED");
      if (reservation === "conflict") return problem(context.req.raw, 409, "IDEMPOTENCY_CONFLICT");
      if (reservation === "unavailable") return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
      const stub = context.env.CONVERSATIONS.get(
        context.env.CONVERSATIONS.idFromName(conversationId),
      );
      let response: Response;
      try {
        response = await stub.fetch(`https://conversation.internal/${resource}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, principalId, idempotencyKey }),
        });
      } catch {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return problem(context.req.raw, 503, "CONVERSATION_UNAVAILABLE");
      }
      if (!response.ok) {
        await releaseReservation(reservation, context.env.DEPLOYMENT_ID);
        return new Response(response.body, response);
      }
      if (!await settleOwnerOperation(reservation, context.env.DEPLOYMENT_ID)) {
        return problem(context.req.raw, 503, "METERING_UNAVAILABLE");
      }
      return new Response(response.body, response);
    });
  }

  app.get("/v1/approvals", async (context) => {
    const url = new URL("https://control.internal/internal/v1/approvals");
    url.searchParams.set("deploymentId", context.env.DEPLOYMENT_ID);
    url.searchParams.set("principalId", context.get("ownerPrincipalId"));
    const response = await context.env.CONTROL.fetch(url);
    return new Response(response.body, response);
  });

  app.post("/v1/approvals/:approvalId", async (context) => {
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return problem(context.req.raw, 400, "IDEMPOTENCY_KEY_REQUIRED");
    const value: unknown = await context.req.json().catch(() => null);
    const decision = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["decision"]
      : undefined;
    if (decision !== "approved" && decision !== "rejected") {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const response = await context.env.CONTROL.fetch(
      "https://control.internal/internal/v1/approvals/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: context.env.DEPLOYMENT_ID,
          principalId: context.get("ownerPrincipalId"),
          approvalId: context.req.param("approvalId"),
          decision,
          idempotencyKey,
          requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
        }),
      },
    );
    if (!response.ok || decision !== "approved") return new Response(response.body, response);
    const approvalResult: unknown = await response.json();
    if (typeof approvalResult !== "object" || approvalResult === null ||
      Array.isArray(approvalResult)) return problem(context.req.raw, 503, "APPROVAL_EXECUTION_UNAVAILABLE");
    const approved = approvalResult as Record<string, unknown>;
    if (typeof approved["executionLease"] !== "string" ||
      typeof approved["capabilityId"] !== "string" ||
      typeof approved["executionRequest"] !== "object" || approved["executionRequest"] === null) {
      return problem(context.req.raw, 503, "APPROVAL_EXECUTION_UNAVAILABLE");
    }
    const execution = await context.env.GOOGLE_GATEKEEPER.fetch(
      "https://google-gatekeeper.internal/internal/v1/google/execute",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: context.env.DEPLOYMENT_ID,
          principalId: context.get("ownerPrincipalId"),
          capabilityId: approved["capabilityId"],
          lease: approved["executionLease"],
          input: approved["executionRequest"],
          requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
          agentId: "agent:assistant",
        }),
      },
    );
    const executionResult: unknown = await execution.json().catch(() => ({}));
    return execution.ok
      ? context.json({ ...approved, execution: executionResult })
      : new Response(JSON.stringify(executionResult), {
          status: execution.status,
          headers: { "Content-Type": "application/problem+json" },
        });
  });

  app.get("/v1/audit", async (context) => {
    const url = new URL("https://control.internal/internal/v1/audit");
    url.searchParams.set("deploymentId", context.env.DEPLOYMENT_ID);
    const response = await context.env.CONTROL.fetch(url);
    return new Response(response.body, response);
  });

  app.all("/v1/*", (context) => problem(context.req.raw, 404, "NOT_FOUND"));
  app.notFound((context) => problem(context.req.raw, 404, "NOT_FOUND"));
  return app;
}

const accessJwtVerifier = new JwtVerifier();

export const accessJwtFromRequest = (request: Request): string | undefined => {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (assertion) return assertion;
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "CF_Authorization") continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const authorizeConfiguredOwner = async (
  request: Request,
  bindings: Bindings,
): Promise<OwnerAuthorization> => {
  // Access normally injects the assertion header. Browser requests also carry
  // the application JWT cookie, which is verified identically as a fallback.
  const token = accessJwtFromRequest(request);
  if (
    !token ||
    !bindings.ACCESS_ISSUER ||
    !bindings.ACCESS_AUDIENCE ||
    !bindings.ACCESS_JWKS_URI ||
    !bindings.OWNER_EMAIL
  ) {
    return { outcome: "unavailable" };
  }
  try {
    const claims = await accessJwtVerifier.verify(token, {
      issuer: bindings.ACCESS_ISSUER,
      audiences: [bindings.ACCESS_AUDIENCE],
      jwksUri: bindings.ACCESS_JWKS_URI,
    });
    const response = await bindings.CONTROL.fetch(
      "https://control.internal/internal/v1/identity/owner/authenticate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: bindings.DEPLOYMENT_ID,
          issuer: claims.iss,
          subject: claims.sub,
          email: claims["email"],
          ownerEmail: bindings.OWNER_EMAIL,
        }),
      },
    );
    if (response.status === 403) return { outcome: "denied" };
    if (!response.ok) return { outcome: "unavailable" };
    const result: unknown = await response.json();
    const principalId = typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)["principalId"]
      : undefined;
    return typeof principalId === "string"
      ? { outcome: "authorized", principalId }
      : { outcome: "unavailable" };
  } catch (error) {
    return error instanceof IdentityError
      ? { outcome: "denied" }
      : { outcome: "unavailable" };
  }
};

const app = createAssistantApp({
  authorizeOwner: authorizeConfiguredOwner,
});

export default app;
