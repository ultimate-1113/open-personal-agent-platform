import { z } from "zod";

export const ISO_DATE_TIME = z.iso.datetime({ offset: true });
export const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonSchema = Readonly<Record<string, unknown>>;

export const principalKindSchema = z.enum([
  "owner",
  "delegated",
  "service",
  "agent",
  "anonymous",
]);

export const principalSchema = z
  .object({
    principalId: identifierSchema,
    deploymentId: identifierSchema,
    kind: principalKindSchema,
    issuer: z.string().url().optional(),
    subject: z.string().min(1).max(500).optional(),
    audienceIds: z.array(identifierSchema).default([]),
  })
  .superRefine((principal, context) => {
    if (
      (principal.kind === "owner" || principal.kind === "delegated") &&
      (!principal.issuer || !principal.subject)
    ) {
      context.addIssue({
        code: "custom",
        message: `${principal.kind} principals require issuer and subject`,
      });
    }
  });

export type Principal = z.infer<typeof principalSchema>;
export type PrincipalKind = z.infer<typeof principalKindSchema>;

export const visibilitySchema = z.enum([
  "public",
  "owner",
  "delegated-principal",
]);
export const sensitivitySchema = z.enum(["normal", "sensitive", "secret"]);
export const trustLevelSchema = z.enum(["trusted", "external", "untrusted"]);

export const retentionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("ttl"), expiresAt: ISO_DATE_TIME }),
  z.object({ mode: z.literal("until-deleted") }),
]);

export const informationPolicySchema = z.object({
  deploymentId: identifierSchema.optional(),
  subjectPrincipalIds: z.array(identifierSchema),
  visibility: visibilitySchema,
  sensitivity: sensitivitySchema,
  trust: trustLevelSchema,
  allowedAudienceIds: z.array(identifierSchema),
  allowedDestinationIds: z.array(identifierSchema),
  retention: retentionSchema,
});

export type Visibility = z.infer<typeof visibilitySchema>;
export type Sensitivity = z.infer<typeof sensitivitySchema>;
export type TrustLevel = z.infer<typeof trustLevelSchema>;
export type Retention = z.infer<typeof retentionSchema>;
export type InformationPolicy = z.infer<typeof informationPolicySchema>;

export const effectSchema = z.enum([
  "read",
  "reversible-write",
  "external-write",
  "destructive",
]);
export const approvalModeSchema = z.enum(["never", "policy", "always"]);

export const capabilityDefinitionSchema = z.object({
  id: identifierSchema,
  version: z.string().min(1).max(100),
  effect: effectSchema,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  gatekeeperId: identifierSchema,
  defaultInformationPolicy: informationPolicySchema,
  approval: approvalModeSchema,
  maxCallsPerTask: z.number().int().positive(),
  allowedDestinationIds: z.array(identifierSchema),
});

export type Effect = z.infer<typeof effectSchema>;
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

export const capabilityGrantSchema = z.object({
  grantId: identifierSchema,
  version: z.number().int().nonnegative(),
  principalId: identifierSchema,
  capabilityId: identifierSchema,
  resourceIds: z.array(identifierSchema),
  allowedDestinationIds: z.array(identifierSchema),
  expiresAt: ISO_DATE_TIME.optional(),
  revokedAt: ISO_DATE_TIME.optional(),
});

export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

export const capabilityInvocationSchema = z.object({
  taskId: identifierSchema,
  capabilityId: identifierSchema,
  resourceId: identifierSchema.optional(),
  destinationId: identifierSchema.optional(),
  input: z.unknown(),
  informationPolicy: informationPolicySchema,
  callsInTask: z.number().int().nonnegative(),
});

export type CapabilityInvocation = z.infer<typeof capabilityInvocationSchema>;

export const policyDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("allow"),
    reasonCode: identifierSchema,
  }),
  z.object({
    outcome: z.literal("requires-approval"),
    reasonCode: identifierSchema,
  }),
  z.object({
    outcome: z.literal("deny"),
    reasonCode: identifierSchema,
    detail: z.string().max(500).optional(),
  }),
]);

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const approvalRequestSchema = z.object({
  approvalId: identifierSchema,
  principalId: identifierSchema,
  capabilityId: identifierSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  preview: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  createdAt: ISO_DATE_TIME,
  expiresAt: ISO_DATE_TIME,
  decidedAt: ISO_DATE_TIME.optional(),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const executionLeaseClaimsSchema = z.object({
  jti: identifierSchema,
  iss: identifierSchema,
  sub: identifierSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  capabilityId: identifierSchema,
  gatekeeperId: identifierSchema,
  taskId: identifierSchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  grantVersion: z.number().int().nonnegative(),
  policyVersion: z.number().int().nonnegative(),
  approvalId: identifierSchema.optional(),
  resourceId: identifierSchema.optional(),
});

export type ExecutionLeaseClaims = z.infer<typeof executionLeaseClaimsSchema>;

export const observationSchema = z.object({
  observationId: identifierSchema,
  deploymentId: identifierSchema,
  principalId: identifierSchema,
  agentId: identifierSchema,
  capabilityId: identifierSchema,
  sourceType: identifierSchema,
  sourceResourceId: z.string().min(1).max(2_000),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  informationPolicy: informationPolicySchema,
  observedAt: ISO_DATE_TIME,
  parentObservationIds: z.array(identifierSchema).default([]),
});

export type Observation = z.infer<typeof observationSchema>;

export const auditEventSchema = z.object({
  eventId: identifierSchema,
  deploymentId: identifierSchema,
  principalId: identifierSchema.optional(),
  eventType: identifierSchema,
  outcome: z.enum(["success", "denied", "failure", "unknown"]),
  requestId: identifierSchema,
  occurredAt: ISO_DATE_TIME,
  metadata: z.record(z.string(), z.unknown()),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

const delegatedAclRuleSchema = z.discriminatedUnion("claim", [
  z.object({
    claim: z.literal("subject"),
    operator: z.enum(["equals", "in"]),
    values: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    claim: z.literal("email"),
    operator: z.enum(["equals", "domain"]),
    values: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    claim: z.literal("group"),
    operator: z.literal("in"),
    values: z.array(z.string().min(1)).min(1),
  }),
]);

export const delegatedSourceAclSchema = z.object({
  issuer: z.string().url(),
  audience: z.string().min(1),
  rules: z.array(delegatedAclRuleSchema).min(1),
});

export type DelegatedSourceAcl = z.infer<typeof delegatedSourceAclSchema>;
export type DelegatedAclRule = DelegatedSourceAcl["rules"][number];

export const pluginManifestSchema = z.object({
  apiVersion: z.literal("opap.dev/v1alpha1"),
  kind: z.literal("Plugin"),
  id: identifierSchema,
  version: z.string().min(1).max(100),
  platformVersion: z.string().min(1).max(100),
  runtime: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("static"),
      package: z.string().min(1),
    }),
    z.object({
      kind: z.literal("sandbox-esm"),
      entrypoint: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.m?js$/u),
    }),
  ]),
  tools: z.array(
    z.object({
      id: identifierSchema,
      description: z.string().min(1).max(1_000),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  requestedCapabilityIds: z.array(identifierSchema),
  limits: z.object({
    timeoutMs: z.number().int().positive().max(30_000),
    outputBytes: z.number().int().positive().max(1_048_576),
    concurrency: z.number().int().positive().max(2),
  }),
  artifact: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sbomPath: z.string().min(1),
    signature: z.string().min(1).optional(),
  }),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const queryRequestSchema = z.object({
  sourceId: identifierSchema,
  query: z.string().min(1).max(8_192),
  mode: z.enum(["search", "answer"]).default("search"),
  maxSources: z.number().int().min(1).max(20).default(5),
});

export type QueryRequest = z.infer<typeof queryRequestSchema>;

export const searchResultSchema = z.object({
  sourceId: identifierSchema,
  resourceId: z.string().min(1),
  title: z.string().min(1),
  uri: z.string().url(),
  observedAt: ISO_DATE_TIME,
  excerpt: z.string(),
  observationId: identifierSchema,
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const meteredResourceSchema = z.enum([
  "worker-request",
  "worker-cpu-ms",
  "durable-object-request",
  "durable-object-duration-gb-s",
  "durable-object-row-read",
  "durable-object-row-write",
  "durable-object-storage-gb-month",
  "d1-row-read",
  "d1-row-write",
  "d1-storage-gb-month",
  "r2-storage-gb-month",
  "r2-class-a",
  "r2-class-b",
  "workers-log-event",
  "container-memory-gib-hour",
  "container-cpu-vcpu-minute",
  "container-disk-gb-hour",
  "workers-ai-neuron",
]);

export type MeteredResource = z.infer<typeof meteredResourceSchema>;

export const nonAiBudgetPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("included-fraction"),
    fraction: z.number().min(0.1).max(1),
  }),
  z.object({ mode: z.literal("unlimited") }),
]);

export const aiBudgetPolicySchema = z.object({
  monthlyOverageUsd: z.number().nonnegative().finite().nullable(),
});

export const cloudCostPolicySchema = z.object({
  nonAi: nonAiBudgetPolicySchema,
  ai: aiBudgetPolicySchema,
  pricingCatalogVersion: z.string().min(1).max(100),
});

export type NonAiBudgetPolicy = z.infer<typeof nonAiBudgetPolicySchema>;
export type AiBudgetPolicy = z.infer<typeof aiBudgetPolicySchema>;
export type CloudCostPolicy = z.infer<typeof cloudCostPolicySchema>;

export const DEFAULT_CLOUD_COST_POLICY: CloudCostPolicy = {
  nonAi: { mode: "included-fraction", fraction: 0.8 },
  ai: { monthlyOverageUsd: 5 },
  pricingCatalogVersion: "cloudflare-2026-08",
};

export const modelProviderIdSchema = z.enum([
  "provider:mock-local",
  "provider:workers-ai",
]);

export const modelProviderSettingSchema = z.object({
  providerId: modelProviderIdSchema,
  enabled: z.boolean(),
  allowedVisibilities: z.array(visibilitySchema).max(3),
  allowedSensitivities: z.array(z.enum(["normal", "sensitive"])).max(2),
});

export const ownerModelSettingsSchema = z.object({
  providers: z.array(modelProviderSettingSchema).length(2),
}).superRefine((settings, context) => {
  const providerIds = new Set(settings.providers.map((provider) => provider.providerId));
  if (providerIds.size !== 2) {
    context.addIssue({ code: "custom", message: "Each supported provider must appear once" });
  }
  if (settings.providers.filter((provider) => provider.enabled).length !== 1) {
    context.addIssue({ code: "custom", message: "Exactly one model provider must be enabled" });
  }
});

export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;
export type ModelProviderSetting = z.infer<typeof modelProviderSettingSchema>;
export type OwnerModelSettings = z.infer<typeof ownerModelSettingsSchema>;

export const DEFAULT_OWNER_MODEL_SETTINGS: OwnerModelSettings = {
  providers: [
    {
      providerId: "provider:mock-local",
      enabled: true,
      allowedVisibilities: ["owner"],
      allowedSensitivities: ["normal"],
    },
    {
      providerId: "provider:workers-ai",
      enabled: false,
      allowedVisibilities: [],
      allowedSensitivities: [],
    },
  ],
};

export const costProblemCodeSchema = z.enum([
  "BUDGET_HARD_LIMIT_REACHED",
  "AI_SPEND_LIMIT_REACHED",
  "STORAGE_BUDGET_REACHED",
  "METERING_UNAVAILABLE",
  "PRICING_CATALOG_STALE",
]);

export type CostProblemCode = z.infer<typeof costProblemCodeSchema>;

export const usageReservationSchema = z.object({
  reservationId: identifierSchema,
  resource: meteredResourceSchema,
  period: z.string().min(1).max(100),
  amount: z.number().positive().finite(),
  expiresAt: ISO_DATE_TIME,
  taskId: identifierSchema.optional(),
  idempotencyKey: z.string().min(1).max(200),
});

export type UsageReservation = z.infer<typeof usageReservationSchema>;

export const usageRecordSchema = z.object({
  resource: meteredResourceSchema,
  period: z.string().min(1).max(100),
  used: z.number().nonnegative().finite(),
  reserved: z.number().nonnegative().finite(),
  softLimit: z.number().nonnegative().finite().nullable(),
  hardLimit: z.number().nonnegative().finite().nullable(),
  mode: z.enum(["normal", "degraded", "blocked", "unlimited"]),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const connectorProviderIdSchema = z.enum(["google", "github", "discord"]);
export const connectionKindSchema = z.enum(["personal", "delegated-source"]);
export const connectionStatusSchema = z.enum(["active", "expired", "revoked", "error"]);

export const connectorConnectionSchema = z.object({
  deploymentId: identifierSchema,
  connectionId: identifierSchema,
  kind: connectionKindSchema,
  providerId: connectorProviderIdSchema,
  scopes: z.array(z.string().min(1).max(500)).max(50),
  resourceIds: z.array(z.string().min(1).max(2_000)).max(500),
  status: connectionStatusSchema,
  createdAt: ISO_DATE_TIME,
  updatedAt: ISO_DATE_TIME,
});

export const oauthCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  tokenType: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1).max(500)).max(50),
  expiresAt: ISO_DATE_TIME.optional(),
  externalSubject: z.string().min(1).max(500).optional(),
});

export type ConnectorProviderId = z.infer<typeof connectorProviderIdSchema>;
export type ConnectionKind = z.infer<typeof connectionKindSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectorConnection = z.infer<typeof connectorConnectionSchema>;
export type OAuthCredential = z.infer<typeof oauthCredentialSchema>;
