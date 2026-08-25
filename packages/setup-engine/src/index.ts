export const setupActions = ["install", "update", "repair", "deactivate", "remove", "doctor"] as const;
export type SetupAction = typeof setupActions[number];
export type SetupProfile = "minimal" | "cloud-base" | "cloud-base-dynamic";

export type DeploymentTarget = {
  apiVersion: "opap.dev/deployment-target/v1alpha1";
  id: "test" | "staging" | "production";
  deploymentName: string;
  deploymentId?: string;
  environment: string;
  profile: SetupProfile;
  providers: {
    aiSearch: boolean;
    discord: boolean;
    google: boolean;
    github: boolean;
    dynamicPlugin: boolean;
  };
  resources: {
    workers: Record<string, string>;
    containers: Record<string, string>;
    d1: Record<string, string>;
    r2: Record<string, string>;
  };
};

export type ProviderSelection = {
  provider: "ai-search" | "discord" | "dynamic-plugin" | "google" | "github";
  enabled: boolean;
  resourceId?: string;
};

export type SetupRequest = {
  action: SetupAction;
  deploymentName: string;
  profile: SetupProfile;
  accountId: string;
  environment: string;
  deploymentId?: string;
  providerSelections: ProviderSelection[];
  ownerBootstrap?: ReturnType<typeof validateOwnerBootstrapConfiguration>;
  dryRun: boolean;
};

export type OwnerBootstrapConfiguration = {
  ownerEmail: string;
  accessTeamDomain: string;
  accessAudience: string;
  ownerTimeZone: string;
  aiGatewayId: string;
};

export type SetupEvent = {
  stage: string;
  status: "pending" | "running" | "success" | "warning" | "failed";
  messageKey: string;
  progress?: number;
  recoverable: boolean;
};

export type ManagedResource = {
  provider: "cloudflare" | "github" | "google" | "discord";
  kind: string;
  id: string;
  name: string;
  ownership: "created" | "reused" | "external";
  deletion: "automatic" | "manual" | "retain";
};

export type SecretReference = {
  secretId: string;
  purpose: string;
  storage: "os-protected" | "passphrase-encrypted" | "cloudflare-only";
  recoverable: boolean;
};

export type InstallationLedger = {
  apiVersion: "opap.dev/installation-ledger/v1alpha1";
  deploymentName: string;
  accountId: string;
  environment: string;
  profile: SetupProfile;
  platformVersion: string;
  createdAt: string;
  updatedAt: string;
  status: "planned" | "installing" | "active" | "deactivated" | "removing" | "removed" | "failed";
  resources: ManagedResource[];
  secrets: SecretReference[];
  completedOperations: string[];
  artifacts?: { workers: Record<string, string> };
};

export type WranglerConfig = {
  name?: string;
  keep_vars?: boolean;
  d1_databases?: Array<{ binding: string; database_name: string; database_id?: string; migrations_dir?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  durable_objects?: { bindings?: Array<{ name: string; class_name: string; script_name?: string }> };
  ai_search?: Array<{ binding: string; instance_name: string }>;
  containers?: Array<Record<string, unknown>>;
  vars?: Record<string, unknown>;
  [key: string]: unknown;
};

const deploymentPattern = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;
const environmentPattern = /^[a-z][a-z0-9-]{1,31}$/u;

export function validateDeploymentName(value: string): string {
  if (!deploymentPattern.test(value)) {
    throw new Error("Deployment name must be 2-24 lowercase letters, numbers, or hyphens");
  }
  return value;
}

export function validateEnvironment(value: string): string {
  if (!environmentPattern.test(value)) throw new Error("Invalid deployment environment");
  return value;
}

export function orderWorkersForDeployment(workers: readonly string[]): string[] {
  const ordered = workers.filter((worker) => worker !== "plugin-runtime-worker");
  if (!workers.includes("plugin-runtime-worker")) return ordered;
  const assistantIndex = ordered.indexOf("assistant-worker");
  ordered.splice(assistantIndex < 0 ? ordered.length : assistantIndex, 0, "plugin-runtime-worker");
  return ordered;
}

export function additionalSecretNamesForExistingWorker(input: {
  worker: string;
  dynamicPluginEnabled: boolean;
}): string[] {
  return input.dynamicPluginEnabled && input.worker === "assistant-worker"
    ? ["PLUGIN_INVOCATION_SIGNING_KEY"]
    : [];
}

export function validateDeploymentTarget(value: unknown): DeploymentTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Deployment target must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input["apiVersion"] !== "opap.dev/deployment-target/v1alpha1" ||
    (input["id"] !== "test" && input["id"] !== "staging" && input["id"] !== "production") ||
    (input["profile"] !== "minimal" && input["profile"] !== "cloud-base" &&
      input["profile"] !== "cloud-base-dynamic") ||
    typeof input["deploymentName"] !== "string" || typeof input["environment"] !== "string" ||
    typeof input["providers"] !== "object" || input["providers"] === null ||
    Array.isArray(input["providers"]) ||
    typeof input["resources"] !== "object" || input["resources"] === null ||
    Array.isArray(input["resources"])) {
    throw new Error("Invalid deployment target");
  }
  const resources = input["resources"] as Record<string, unknown>;
  const providers = input["providers"] as Record<string, unknown>;
  if (["aiSearch", "discord", "google", "github", "dynamicPlugin"]
    .some((key) => typeof providers[key] !== "boolean")) {
    throw new Error("Invalid deployment target providers");
  }
  const validateMap = (value: unknown, label: string): Record<string, string> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid ${label} resource map`);
    }
    const entries = Object.entries(value);
    if (entries.some(([source, target]) => source.length === 0 || typeof target !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(target))) {
      throw new Error(`Invalid ${label} resource name`);
    }
    return Object.fromEntries(entries);
  };
  if (input["deploymentId"] !== undefined &&
    (typeof input["deploymentId"] !== "string" ||
      !/^deployment:[a-z0-9][a-z0-9:-]{1,126}[a-z0-9]$/u.test(input["deploymentId"]))) {
    throw new Error("Invalid deployment target ID");
  }
  return { apiVersion: input["apiVersion"], id: input["id"], profile: input["profile"],
    deploymentName: validateDeploymentName(input["deploymentName"]),
    ...(typeof input["deploymentId"] === "string" ? { deploymentId: input["deploymentId"] } : {}),
    environment: validateEnvironment(input["environment"]), providers: {
      aiSearch: providers["aiSearch"] as boolean,
      discord: providers["discord"] as boolean,
      google: providers["google"] as boolean,
      github: providers["github"] as boolean,
      dynamicPlugin: providers["dynamicPlugin"] as boolean,
    }, resources: {
      workers: validateMap(resources["workers"], "Worker"),
      containers: validateMap(resources["containers"], "Container"),
      d1: validateMap(resources["d1"], "D1"),
      r2: validateMap(resources["r2"], "R2"),
    } };
}

export function validateOwnerBootstrapConfiguration(input: OwnerBootstrapConfiguration): OwnerBootstrapConfiguration & {
  accessIssuer: string;
  accessJwksUri: string;
} {
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail)) throw new Error("A valid Owner email is required");
  const accessTeamDomain = input.accessTeamDomain.trim().toLowerCase()
    .replace(/^https:\/\//u, "").replace(/\/$/u, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(accessTeamDomain)) {
    throw new Error("Access Team Domain must look like team.cloudflareaccess.com");
  }
  const accessAudience = input.accessAudience.trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(accessAudience)) throw new Error("A valid Access Audience is required");
  const ownerTimeZone = input.ownerTimeZone.trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone: ownerTimeZone }); }
  catch { throw new Error("A valid IANA Owner time zone is required"); }
  const aiGatewayId = input.aiGatewayId.trim();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(aiGatewayId)) {
    throw new Error("A valid AI Gateway ID is required");
  }
  const accessIssuer = `https://${accessTeamDomain}`;
  return { ownerEmail, accessTeamDomain, accessAudience, ownerTimeZone, aiGatewayId,
    accessIssuer, accessJwksUri: `${accessIssuer}/cdn-cgi/access/certs` };
}

export function namespaceResourceName(name: string, deploymentName: string, environment: string): string {
  validateDeploymentName(deploymentName);
  validateEnvironment(environment);
  const withoutOpap = name.replace(/^opap-/u, "");
  const withoutEnvironment = withoutOpap.replace(/-(?:development|dev|staging|production)$/u, "");
  return `${deploymentName}-${withoutEnvironment}-${environment}`;
}

export function namespaceWorkerName(name: string, deploymentName: string): string {
  validateDeploymentName(deploymentName);
  const suffix = name.replace(/^opap-/u, "");
  const result = `${deploymentName}-${suffix}`;
  if (result.length > 63) throw new Error(`Generated Worker name is too long: ${result}`);
  return result;
}

export function collectSelectedServiceNames(configs: Iterable<WranglerConfig>): Set<string> {
  return new Set([...configs]
    .map((config) => config.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0));
}

export function transformWranglerConfig(input: WranglerConfig, request: SetupRequest,
  selectedWorkerNames: ReadonlySet<string>, target?: DeploymentTarget): WranglerConfig {
  const config = structuredClone(input);
  const originalName = config.name;
  const resolve = (kind: "workers" | "d1" | "r2", source: string, fallback: () => string): string => {
    if (!target) return fallback();
    const explicit = target.resources[kind][source];
    if (!explicit) throw new Error(`Deployment target ${target.id} does not define ${kind}: ${source}`);
    return explicit;
  };
  if (originalName) config.name = resolve("workers", originalName,
    () => namespaceWorkerName(originalName, request.deploymentName));
  for (const database of config.d1_databases ?? []) {
    const source = database.database_name;
    database.database_name = resolve("d1", source,
      () => namespaceResourceName(source, request.deploymentName, request.environment));
    delete database.database_id;
  }
  for (const bucket of config.r2_buckets ?? []) {
    const source = bucket.bucket_name;
    bucket.bucket_name = resolve("r2", source,
      () => namespaceResourceName(source, request.deploymentName, request.environment));
  }
  config.services = (config.services ?? [])
    .filter((service) => selectedWorkerNames.has(service.service))
    .map((service) => ({ ...service, service: resolve("workers", service.service,
      () => namespaceWorkerName(service.service, request.deploymentName)) }));
  for (const binding of config.durable_objects?.bindings ?? []) {
    if (binding.script_name) {
      const source = binding.script_name;
      binding.script_name = resolve("workers", source,
        () => namespaceWorkerName(source, request.deploymentName));
    }
  }
  if (!request.providerSelections.some((item) => item.provider === "ai-search" && item.enabled)) {
    delete config.ai_search;
  }
  if (config.vars?.["ENVIRONMENT"] !== undefined) config.vars["ENVIRONMENT"] = request.environment;
  if (config.vars?.["DEPLOYMENT_ID"] !== undefined) {
    config.vars["DEPLOYMENT_ID"] = request.deploymentId ??
      `deployment:${request.deploymentName}:${request.environment}`;
  }
  const owner = request.ownerBootstrap;
  if (owner && config.vars) {
    if (config.vars["OWNER_EMAIL"] !== undefined) config.vars["OWNER_EMAIL"] = owner.ownerEmail;
    if (config.vars["OWNER_TIME_ZONE"] !== undefined) config.vars["OWNER_TIME_ZONE"] = owner.ownerTimeZone;
    if (config.vars["ACCESS_ISSUER"] !== undefined) config.vars["ACCESS_ISSUER"] = owner.accessIssuer;
    if (config.vars["ACCESS_AUDIENCE"] !== undefined) config.vars["ACCESS_AUDIENCE"] = owner.accessAudience;
    if (config.vars["ACCESS_JWKS_URI"] !== undefined) config.vars["ACCESS_JWKS_URI"] = owner.accessJwksUri;
    if (config.vars["AI_GATEWAY_ID"] !== undefined) config.vars["AI_GATEWAY_ID"] = owner.aiGatewayId;
  }
  return config;
}

export const allowedNetworkHosts = new Set([
  "api.cloudflare.com", "dash.cloudflare.com", "github.com", "api.github.com",
  "accounts.google.com", "oauth2.googleapis.com", "console.cloud.google.com",
  "discord.com", "api.discord.com", "one.dash.cloudflare.com",
]);

export function assertAllowedUrl(value: string): URL {
  const url = new URL(value);
  const loopback = (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1")
    && url.protocol === "http:";
  if (!loopback && (url.protocol !== "https:" || !allowedNetworkHosts.has(url.hostname))) {
    throw new Error(`Installer network destination is not allowed: ${url.origin}`);
  }
  return url;
}

export function createInstallPlan(request: SetupRequest, workers: readonly string[]): SetupEvent[] {
  validateDeploymentName(request.deploymentName);
  validateEnvironment(request.environment);
  const stages = ["preflight", "secrets", "resources", "migrations", ...workers.map((worker) => `deploy:${worker}`), "smoke"];
  return stages.map((stage, index) => ({
    stage,
    status: "pending",
    messageKey: `setup.${stage}`,
    progress: Math.round((index / stages.length) * 100),
    recoverable: true,
  }));
}

export function selectWorkersToDeploy(input: {
  action: "setup" | "update" | "repair";
  workers: readonly string[];
  existingWorkerNames: ReadonlySet<string>;
  resolvedWorkerNames: Readonly<Record<string, string | undefined>>;
  previousStatus?: InstallationLedger["status"];
  previousArtifacts?: Readonly<Record<string, string>>;
  currentArtifacts: Readonly<Record<string, string>>;
}): string[] {
  if (input.action !== "update" || input.previousStatus !== "active" || !input.previousArtifacts) {
    return [...input.workers];
  }
  return input.workers.filter((worker) => {
    const resolvedName = input.resolvedWorkerNames[worker];
    return !resolvedName || !input.existingWorkerNames.has(resolvedName)
      || input.previousArtifacts?.[worker] !== input.currentArtifacts[worker];
  });
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const allowed = new Set(["stage", "status", "messageKey", "progress", "resourceId", "resourceName", "errorCode", "host", "purpose"]);
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => allowed.has(key)
      && (["string", "number", "boolean"].includes(typeof value) || value === null))
    .map(([key, value]) => [key, value as string | number | boolean | null]));
}

export function isAlreadyAbsentCloudflareError(message: string): boolean {
  return /(does not exist|not found|couldn't find|\[code:\s*10090\])/iu.test(message);
}

export function shouldBackupD1(input: {
  wasPresentAtStart: boolean;
  previousLedgerStatus?: InstallationLedger["status"] | undefined;
  previousOwnership?: ManagedResource["ownership"] | undefined;
}): boolean {
  if (!input.wasPresentAtStart) return false;
  const incompleteInstallerRun = input.previousOwnership === "created"
    && ["planned", "installing", "failed", "removed"].includes(input.previousLedgerStatus ?? "");
  return !incompleteInstallerRun;
}
