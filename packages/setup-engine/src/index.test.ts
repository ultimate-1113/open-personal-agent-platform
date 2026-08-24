import { describe, expect, it } from "vitest";
import { assertAllowedUrl, collectSelectedServiceNames, createInstallPlan, isAlreadyAbsentCloudflareError,
  namespaceWorkerName, sanitizeLogFields,
  transformWranglerConfig, validateDeploymentName, validateOwnerBootstrapConfiguration,
  validateDeploymentTarget, type SetupRequest } from "./index";
import { validateEnvironment } from "./index";

const request: SetupRequest = { action: "install", deploymentName: "opap-test-a1b2c3",
  profile: "cloud-base", accountId: "account", environment: "staging", providerSelections: [], dryRun: true };

describe("setup engine", () => {
  it("derives service names from Wrangler configuration instead of folder names", () => {
    expect([...collectSelectedServiceNames([
      { name: "opap-policy-control" },
      { name: "opap-plugin-runtime" },
    ])]).toEqual(["opap-policy-control", "opap-plugin-runtime"]);
  });
  it("validates named test and production deployment targets", () => {
    expect(validateDeploymentTarget({ apiVersion: "opap.dev/deployment-target/v1alpha1",
      id: "test", deploymentName: "opap-test", environment: "staging",
      profile: "cloud-base-dynamic", providers: { aiSearch: false, discord: false, google: false,
        github: false, dynamicPlugin: true }, resources: { workers: { "opap-assistant": "opap-test-assistant" },
        containers: {}, d1: {}, r2: {} } }).deploymentName).toBe("opap-test");
    expect(() => validateDeploymentTarget({ id: "production", deploymentName: "../opap" }))
      .toThrow();
  });
  it("namespaces every internal Worker reference", () => {
    const transformed = transformWranglerConfig({ name: "opap-assistant",
      services: [{ binding: "CONTROL", service: "opap-policy-control" }],
      durable_objects: { bindings: [{ name: "QUOTA", class_name: "Quota", script_name: "opap-quota" }] },
      d1_databases: [{ binding: "DB", database_name: "opap-control-development" }],
      ai_search: [{ binding: "AI_SEARCH", instance_name: "account-specific" }] }, request,
    new Set(["opap-assistant", "opap-policy-control", "opap-quota"]));
    expect(transformed.name).toBe("opap-test-a1b2c3-assistant");
    expect(transformed.services?.[0]?.service).toBe("opap-test-a1b2c3-policy-control");
    expect(transformed.durable_objects?.bindings?.[0]?.script_name).toBe("opap-test-a1b2c3-quota");
    expect(transformed.d1_databases?.[0]?.database_name).toBe("opap-test-a1b2c3-control-staging");
    expect(transformed.ai_search).toBeUndefined();
  });
  it("uses only explicit target resource names when a target is selected", () => {
    const target = validateDeploymentTarget({ apiVersion: "opap.dev/deployment-target/v1alpha1",
      id: "test", deploymentName: "opap-test", environment: "staging", profile: "cloud-base",
      providers: { aiSearch: false, discord: false, google: false, github: false,
        dynamicPlugin: false },
      resources: { workers: { "opap-assistant": "explicit-assistant",
        "opap-policy-control": "explicit-control" },
      containers: {}, d1: { "opap-control-development": "explicit-control-db" }, r2: {} } });
    const transformed = transformWranglerConfig({ name: "opap-assistant",
      services: [{ binding: "CONTROL", service: "opap-policy-control" }],
      d1_databases: [{ binding: "DB", database_name: "opap-control-development" }] },
    request, new Set(["opap-assistant", "opap-policy-control"]), target);
    expect(transformed.name).toBe("explicit-assistant");
    expect(transformed.services?.[0]?.service).toBe("explicit-control");
    expect(transformed.d1_databases?.[0]?.database_name).toBe("explicit-control-db");
  });
  it("rejects unsafe deployment names and destinations", () => {
    expect(() => validateDeploymentName("OPAP_Test")).toThrow();
    expect(() => validateEnvironment("1bad")).toThrow();
    expect(() => assertAllowedUrl("http://example.com/token")).toThrow();
    expect(() => assertAllowedUrl("https://example.com/token")).toThrow();
    expect(assertAllowedUrl("http://127.0.0.1:4567/callback").hostname).toBe("127.0.0.1");
    expect(assertAllowedUrl("https://api.cloudflare.com/client/v4").hostname).toBe("api.cloudflare.com");
  });
  it("never serializes unknown log fields", () => {
    expect(sanitizeLogFields({ stage: "deploy", authorization: "Bearer secret", prompt: "private" }))
      .toEqual({ stage: "deploy" });
  });
  it("treats only Cloudflare not-found deletion outcomes as already absent", () => {
    expect(isAlreadyAbsentCloudflareError("This Worker does not exist on this account. [code: 10090]")).toBe(true);
    expect(isAlreadyAbsentCloudflareError("Couldn't find DB with name opap-test")).toBe(true);
    expect(isAlreadyAbsentCloudflareError("Authentication failed [code: 10000]")).toBe(false);
  });
  it("creates a reviewable dry-run plan", () => {
    expect(createInstallPlan(request, ["quota-worker", "assistant-worker"]).map((event) => event.stage))
      .toContain("deploy:assistant-worker");
  });
  it("enforces the Worker name limit", () => {
    expect(() => namespaceWorkerName("opap-assistant", "a".repeat(24))).not.toThrow();
    expect(() => namespaceWorkerName(`opap-${"worker".repeat(10)}`, "a".repeat(24))).toThrow(/too long/u);
  });
  it("keeps selected AI Search and drops unavailable services", () => {
    const withAi = { ...request, providerSelections: [{ provider: "ai-search" as const, enabled: true }] };
    const transformed = transformWranglerConfig({ services: [{ binding: "MISSING", service: "opap-missing" }],
      ai_search: [{ binding: "AI", instance_name: "instance" }], vars: { ENVIRONMENT: "dev",
        DEPLOYMENT_ID: "old" } }, withAi, new Set());
    expect(transformed.services).toEqual([]);
    expect(transformed.ai_search).toHaveLength(1);
    expect(transformed.vars).toEqual({ ENVIRONMENT: "staging", DEPLOYMENT_ID: "deployment:opap-test-a1b2c3:staging" });
  });
  it("derives Access endpoints and applies owner bootstrap variables", () => {
    const ownerBootstrap = validateOwnerBootstrapConfiguration({ ownerEmail: "Owner@Example.com ",
      accessTeamDomain: "https://team.cloudflareaccess.com/", accessAudience: "audience_1234567890",
      ownerTimeZone: "Asia/Tokyo", aiGatewayId: "opap-gateway" });
    expect(ownerBootstrap.accessJwksUri).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
    const transformed = transformWranglerConfig({ vars: { OWNER_EMAIL: "old", OWNER_TIME_ZONE: "UTC",
      ACCESS_ISSUER: "old", ACCESS_AUDIENCE: "old", ACCESS_JWKS_URI: "old", AI_GATEWAY_ID: "old" } },
    { ...request, ownerBootstrap }, new Set());
    expect(transformed.vars).toMatchObject({ OWNER_EMAIL: "owner@example.com", OWNER_TIME_ZONE: "Asia/Tokyo",
      ACCESS_ISSUER: "https://team.cloudflareaccess.com", ACCESS_AUDIENCE: "audience_1234567890",
      AI_GATEWAY_ID: "opap-gateway" });
  });
});
