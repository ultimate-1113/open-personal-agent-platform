import { describe, expect, it } from "vitest";
import {
  DEFAULT_OWNER_MODEL_SETTINGS,
  type OwnerModelSettings,
} from "../packages/contracts/src/index.js";
import {
  createAssistantApp,
  type ModelSettingsRepository,
} from "../apps/assistant-worker/src/index.js";

class InMemoryModelSettings implements ModelSettingsRepository {
  settings = DEFAULT_OWNER_MODEL_SETTINGS;
  updates = new Map<string, string>();

  get(): Promise<OwnerModelSettings> {
    return Promise.resolve(this.settings);
  }

  update(
    settings: OwnerModelSettings,
    audit: { idempotencyKey: string },
  ): Promise<OwnerModelSettings> {
    const fingerprint = JSON.stringify(settings);
    const existing = this.updates.get(audit.idempotencyKey);
    if (existing && existing !== fingerprint) return Promise.reject(new Error("IDEMPOTENCY_CONFLICT"));
    this.updates.set(audit.idempotencyKey, fingerprint);
    this.settings = settings;
    return Promise.resolve(settings);
  }
}

const appWith = (repository: ModelSettingsRepository) => createAssistantApp({
  authorizeOwner: () => Promise.resolve({
    outcome: "authorized" as const,
    principalId: "principal:owner",
  }),
  modelSettings: repository,
});

describe("owner model provider API", () => {
  it("starts fail-closed on Mock Local and requires exactly one provider", async () => {
    const app = appWith(new InMemoryModelSettings());
    expect(await (await app.request("/v1/settings/providers")).json()).toEqual(
      DEFAULT_OWNER_MODEL_SETTINGS,
    );
    const invalid = await app.request("/v1/settings/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "provider:invalid" },
      body: JSON.stringify({
        providers: DEFAULT_OWNER_MODEL_SETTINGS.providers.map((provider) => ({
          ...provider,
          enabled: true,
        })),
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it("persists an explicit Workers AI destination grant idempotently", async () => {
    const repository = new InMemoryModelSettings();
    const app = appWith(repository);
    const settings: OwnerModelSettings = {
      providers: DEFAULT_OWNER_MODEL_SETTINGS.providers.map((provider) =>
        provider.providerId === "provider:workers-ai"
          ? {
              ...provider,
              enabled: true,
              allowedVisibilities: ["owner"],
              allowedSensitivities: ["normal"],
            }
          : { ...provider, enabled: false }
      ),
    };
    const update = () => app.request("/v1/settings/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "provider:workers" },
      body: JSON.stringify(settings),
    });
    expect((await update()).status).toBe(200);
    expect((await update()).status).toBe(200);
    expect(repository.updates).toHaveLength(1);
  });
});
