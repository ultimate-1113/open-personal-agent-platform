import { Hono } from "hono";
import { queryRequestSchema, type Principal, type SearchResult } from "@opap/contracts";
import {
  createDelegatedPrincipal,
  IdentityError,
  JwtVerifier,
  type JwtClaims,
} from "@opap/identity";

type Bindings = {
  ENVIRONMENT: string;
  DEPLOYMENT_ID: string;
  DELEGATED_ISSUER: string;
  DELEGATED_AUDIENCE: string;
  DELEGATED_JWKS_URI: string;
  DELEGATED_PRINCIPAL_HMAC_SECRET: string;
  CONTROL: Fetcher;
};

type DelegatedIdentity = { claims: JwtClaims; principal: Principal };
type AuthorizedSource = {
  sourceId: string;
  sourceType: string;
  resourceIds: readonly string[];
};

const isAuthorizedSource = (value: unknown): value is AuthorizedSource => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source["sourceId"] === "string" &&
    typeof source["sourceType"] === "string" &&
    Array.isArray(source["resourceIds"]) &&
    source["resourceIds"].every((resource) => typeof resource === "string");
};

export type DelegatedDependencies = {
  authenticate(request: Request, bindings: Bindings): Promise<DelegatedIdentity>;
  authorizeSource(
    sourceId: string,
    identity: DelegatedIdentity,
    bindings: Bindings,
  ): Promise<AuthorizedSource | undefined>;
};

const problem = (request: Request, status: 400 | 401 | 403 | 404 | 503, title: string) =>
  Response.json(
    {
      type: `https://opap.dev/problems/${title.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    },
    { status, headers: { "Content-Type": "application/problem+json" } },
  );

export function createDelegatedApp(dependencies: DelegatedDependencies) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: { delegatedIdentity: DelegatedIdentity };
  }>();

  app.get("/health", (context) =>
    context.json({ service: "delegated-agent-api", status: "ok" }),
  );

  app.use("/v1/*", async (context, next) => {
    try {
      context.set(
        "delegatedIdentity",
        await dependencies.authenticate(context.req.raw, context.env),
      );
      return next();
    } catch (error) {
      return problem(
        context.req.raw,
        error instanceof IdentityError ? 401 : 503,
        error instanceof IdentityError ? error.code : "DELEGATED_AUTH_UNAVAILABLE",
      );
    }
  });

  app.post("/v1/query", async (context) => {
    const raw = await context.req.text();
    if (new TextEncoder().encode(raw).byteLength > 8 * 1024) {
      return problem(context.req.raw, 400, "REQUEST_TOO_LARGE");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return problem(context.req.raw, 400, "INVALID_REQUEST");
    }
    const parsed = queryRequestSchema.safeParse(value);
    if (!parsed.success) return problem(context.req.raw, 400, "INVALID_REQUEST");
    const identity = context.get("delegatedIdentity");
    const source = await dependencies.authorizeSource(
      parsed.data.sourceId,
      identity,
      context.env,
    );
    if (!source) return problem(context.req.raw, 403, "DELEGATED_ACL_DENIED");
    if (parsed.data.mode === "answer") {
      return problem(context.req.raw, 403, "MODEL_DESTINATION_DENIED");
    }
    const resourceId = source.resourceIds[0];
    if (!resourceId) return problem(context.req.raw, 404, "SOURCE_EMPTY");
    const result: SearchResult = {
      sourceId: source.sourceId,
      resourceId,
      title: `Authorized ${source.sourceType} source`,
      uri: `opap://${source.sourceType}/${encodeURIComponent(resourceId)}`,
      observedAt: new Date().toISOString(),
      excerpt: `Authorized fixture result for: ${parsed.data.query}`,
      observationId: `observation:${crypto.randomUUID()}`,
    };
    return context.json(
      { mode: "search", principalId: identity.principal.principalId, results: [result] },
      200,
      { "Cache-Control": "private, no-store" },
    );
  });

  app.all("/v1/*", (context) => problem(context.req.raw, 404, "NOT_FOUND"));
  return app;
}

const verifier = new JwtVerifier();

const app = createDelegatedApp({
  async authenticate(request, bindings) {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new IdentityError("JWT_MALFORMED", "Bearer token is required");
    }
    const claims = await verifier.verify(authorization.slice(7), {
      issuer: bindings.DELEGATED_ISSUER,
      audiences: [bindings.DELEGATED_AUDIENCE],
      jwksUri: bindings.DELEGATED_JWKS_URI,
    });
    return {
      claims,
      principal: await createDelegatedPrincipal({
        claims,
        deploymentId: bindings.DEPLOYMENT_ID,
        hmacSecret: bindings.DELEGATED_PRINCIPAL_HMAC_SECRET,
      }),
    };
  },
  async authorizeSource(sourceId, identity, bindings) {
    const response = await bindings.CONTROL.fetch(
      "https://control.internal/internal/v1/delegated/source/authorize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentId: bindings.DEPLOYMENT_ID,
          sourceId,
          principalId: identity.principal.principalId,
          claims: identity.claims,
        }),
      },
    );
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return isAuthorizedSource(value) ? value : undefined;
  },
});

export default app;
