import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readConfig = async (app: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(resolve("apps", app, "wrangler.jsonc"), "utf8"),
  ) as Record<string, unknown>;

describe("Worker binding boundaries", () => {
  it("keeps every private binding out of the public API", async () => {
    const config = await readConfig("public-agent-api");
    for (const forbidden of [
      "services",
      "d1_databases",
      "r2_buckets",
      "vpc_services",
      "dispatch_namespaces",
    ]) {
      expect(config).not.toHaveProperty(forbidden);
    }
    expect(config.ratelimits).toEqual([
      expect.objectContaining({ name: "PUBLIC_RATE_LIMITER" }),
    ]);
    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.ai_search).toEqual([
      { binding: "AI_SEARCH", instance_name: "okidev-web", remote: true },
    ]);
    expect(String((config.vars as Record<string, unknown>)["PUBLIC_SOURCES_JSON"]))
      .not.toContain("public-endpoint");
    expect(config.workers_dev).toBe(false);
    const durableObjects = config.durable_objects as {
      bindings: { name: string; class_name: string; script_name?: string }[];
    };
    expect(durableObjects.bindings).toEqual([
      {
        name: "PUBLIC_QUOTA",
        class_name: "QuotaDurableObject",
        script_name: "opap-quota",
      },
    ]);
  });

  it("keeps the quota worker private", async () => {
    const config = await readConfig("quota-worker");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
  });

  it("keeps conversation state in a private SQLite Durable Object", async () => {
    const config = await readConfig("conversation-agent");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["ConversationAgent"] },
    ]);
  });

  it("keeps the audit ledger private and SQLite-backed", async () => {
    const config = await readConfig("audit-ledger-worker");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["AuditLedger"] },
    ]);
  });

  it("serves the Owner UI from the Assistant origin", async () => {
    const config = await readConfig("assistant-worker");
    expect(config.assets).toMatchObject({
      directory: "../owner-ui/dist",
      not_found_handling: "single-page-application",
    });
  });

  it("does not expose the policy control worker publicly", async () => {
    const config = await readConfig("policy-control-worker");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
  });

  it("does not bind personal gatekeepers to the delegated API", async () => {
    const config = await readConfig("delegated-agent-api");
    const services = config.services as { binding: string }[];
    expect(services).toEqual([
      { binding: "CONTROL", service: "opap-policy-control" },
      { binding: "DELEGATED_SOURCE_READ", service: "opap-delegated-source-gatekeeper",
        entrypoint: "DelegatedSourceReadEntrypoint" },
    ]);
  });

  it("keeps delegated source credentials in a separate private read-only gatekeeper", async () => {
    const config = await readConfig("delegated-source-gatekeeper");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("ai");
    expect(config).not.toHaveProperty("services");
    const databases = config.d1_databases as { binding: string }[];
    expect(databases.map((database) => database.binding)).toEqual(["SOURCE_DB"]);

    const source = await readFile(resolve("apps", "delegated-source-gatekeeper", "src", "index.ts"), "utf8");
    expect(source).not.toMatch(/gmail|calendar|createGitHubIssue|createGitHubIssueComment/iu);
    expect(source).toMatch(/RESOURCE_SCOPE_DENIED/u);
    expect(source).toMatch(/resourceIds\.includes/u);
  });

  it("keeps Discord public ingress isolated from private platform state", async () => {
    const config = await readConfig("discord-adapter");
    expect(config).not.toHaveProperty("d1_databases");
    expect(config).not.toHaveProperty("ai");
    expect(config).not.toHaveProperty("r2_buckets");
    const services = config.services as { binding: string; entrypoint?: string }[];
    expect(services).toEqual([
      { binding: "ASSISTANT", service: "opap-assistant", entrypoint: "DiscordEntrypoint" },
      { binding: "DISCORD_GATEKEEPER", service: "opap-discord-gatekeeper" },
    ]);
    const durableObjects = config.durable_objects as { bindings: { name: string }[] };
    expect(durableObjects.bindings.map((binding) => binding.name)).toEqual(["DISCORD_DEDUPE"]);
  });

  it("keeps the Discord Gatekeeper and Bot Token off public routes", async () => {
    const config = await readConfig("discord-gatekeeper");
    expect(config.workers_dev).toBe(false);
    expect(config).not.toHaveProperty("routes");
    expect(JSON.stringify(config)).not.toContain("DISCORD_BOT_TOKEN");
  });

  it("stores only low-frequency Discord link state in Control D1", async () => {
    const migration = await readFile(resolve("migrations", "control", "0004_discord_links.sql"), "utf8");
    expect(migration).toMatch(/code_digest/u);
    expect(migration).not.toMatch(/interaction_token|bot_token|message_content/iu);
    expect(migration).toMatch(/UNIQUE \(deployment_id, discord_user_id\)/u);
  });

  it("keeps high-volume observations and audit events out of D1", async () => {
    const migration = await readFile(
      resolve("migrations", "control", "0001_initial.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/CREATE TABLE observations/u);
    expect(migration).not.toMatch(/CREATE TABLE audit_events/u);
    expect(migration).toMatch(/CREATE TABLE audit_checkpoints/u);
  });

  it("does not create a dedicated 30 second audit alarm", async () => {
    const migration = await readFile(
      resolve("migrations", "durable-objects", "conversation", "0001_initial.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/delivered_at/u);
    expect(migration).not.toMatch(/30\s*second/iu);
  });

  it("requires a checkpoint before an audit segment can be deleted", async () => {
    const migration = await readFile(
      resolve("migrations", "durable-objects", "audit-ledger", "0001_initial.sql"),
      "utf8",
    );
    expect(migration).toMatch(/opap_audit_segments_checkpoint_required/u);
    expect(migration).toMatch(/checkpoint_r2_key IS NULL/u);
  });
});
