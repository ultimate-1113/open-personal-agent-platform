import { Hono } from "hono";
import { queryRequestSchema, type SearchResult } from "@opap/contracts";

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  PUBLIC_RATE_LIMITER: RateLimit;
  PUBLIC_QUOTA: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();
const publicCache = (): Cache =>
  (caches as unknown as { default: Cache }).default;

app.get("/health", (context) =>
  context.json({ service: "public-agent-api", status: "ok" }),
);

app.post("/v1/query", async (context) => {
  const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
  const actorKey = context.req.header("cf-connecting-ip") ?? "anonymous";
  const rateLimit = await context.env.PUBLIC_RATE_LIMITER.limit({
    key: `query:${actorKey}`,
  });
  if (!rateLimit.success) {
    return context.json(
      {
        type: "https://opap.dev/problems/rate-limit-exceeded",
        title: "Rate limit exceeded",
        status: 429,
        requestId,
      },
      429,
      { "Content-Type": "application/problem+json", "Retry-After": "60" },
    );
  }

  const body = await context.req.text();
  if (new TextEncoder().encode(body).byteLength > 8 * 1024) {
    return context.json(
      {
        type: "https://opap.dev/problems/request-too-large",
        title: "Query request exceeds 8 KiB",
        status: 413,
        requestId,
      },
      413,
      { "Content-Type": "application/problem+json" },
    );
  }

  let value: unknown = null;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    // The schema error below intentionally handles malformed JSON uniformly.
  }
  const parsed = queryRequestSchema.safeParse(value);
  if (!parsed.success) {
    return context.json(
      {
        type: "https://opap.dev/problems/invalid-request",
        title: "Invalid query request",
        status: 400,
        requestId,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
      { "Content-Type": "application/problem+json" },
    );
  }

  if (parsed.data.sourceId !== "source:public-fixture") {
    return context.json(
      {
        type: "https://opap.dev/problems/source-not-found",
        title: "Public source not found",
        status: 404,
        requestId,
      },
      404,
      { "Content-Type": "application/problem+json" },
    );
  }

  const cacheKey = new Request(
    `https://public-cache.opap.invalid/query?${new URLSearchParams({
      sourceId: parsed.data.sourceId,
      query: parsed.data.query,
      maxSources: String(parsed.data.maxSources),
    }).toString()}`,
  );
  if (parsed.data.mode === "search") {
    const cached = await publicCache().match(cacheKey);
    if (cached) return cached;
  }

  if (parsed.data.mode === "answer") {
    return context.json(
      {
        type: "https://opap.dev/problems/model-destination-denied",
        title: "MODEL_DESTINATION_DENIED",
        status: 403,
        requestId,
      },
      403,
      { "Content-Type": "application/problem+json" },
    );
  }

  const now = new Date();
  const reservationId = `reservation:${crypto.randomUUID()}`;
  const quota = context.env.PUBLIC_QUOTA.get(
    context.env.PUBLIC_QUOTA.idFromName("public"),
  );
  let quotaResponse: Response;
  try {
    quotaResponse = await quota.fetch("https://quota.internal/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reserve",
        deploymentId: context.env.DEPLOYMENT_ID,
        reservationId,
        idempotencyKey: context.req.header("idempotency-key") ?? requestId,
        scopeId: "public",
        resource: "public-cache-miss",
        amount: 1,
        period: now.toISOString().slice(0, 7),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      }),
    });
  } catch {
    return context.json(
      {
        type: "https://opap.dev/problems/metering-unavailable",
        title: "METERING_UNAVAILABLE",
        status: 503,
        requestId,
      },
      503,
      { "Content-Type": "application/problem+json" },
    );
  }
  if (!quotaResponse.ok) {
    const problem = (await quotaResponse.json().catch(() => null)) as
      | { code?: string }
      | null;
    const code = problem?.code ?? "METERING_UNAVAILABLE";
    const status = quotaResponse.status === 429 ? 429 : 503;
    return context.json(
      {
        type: `https://opap.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
        title: code,
        status,
        requestId,
      },
      status,
      { "Content-Type": "application/problem+json" },
    );
  }

  const result: SearchResult = {
    sourceId: parsed.data.sourceId,
    resourceId: "document:getting-started",
    title: "Getting started",
    uri: "https://example.invalid/docs/getting-started",
    observedAt: new Date().toISOString(),
    excerpt: `Fixture result for: ${parsed.data.query}`,
    observationId: `observation:${crypto.randomUUID()}`,
  };
  const response = context.json(
    { mode: "search", results: [result] },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
  const settle = await quota.fetch("https://quota.internal/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "settle",
      deploymentId: context.env.DEPLOYMENT_ID,
      reservationId,
      actualAmount: 1,
    }),
  });
  if (!settle.ok) {
    return context.json(
      {
        type: "https://opap.dev/problems/metering-unavailable",
        title: "METERING_UNAVAILABLE",
        status: 503,
        requestId,
      },
      503,
      { "Content-Type": "application/problem+json" },
    );
  }
  context.executionCtx.waitUntil(publicCache().put(cacheKey, response.clone()));
  return response;
});

export default app;
