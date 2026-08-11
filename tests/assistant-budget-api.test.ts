import { describe, expect, it } from "vitest";
import { DEFAULT_CLOUD_COST_POLICY } from "../packages/contracts/src/index.js";
import { InMemoryCostPolicyRepository } from "../packages/cost-control/src/index.js";
import { createAssistantApp } from "../apps/assistant-worker/src/index.js";

const authorizedApp = (repository = new InMemoryCostPolicyRepository()) =>
  ({
    app: createAssistantApp({
      authorizeOwner: () =>
        Promise.resolve({ outcome: "authorized" as const, principalId: "principal:owner" }),
      costPolicies: repository,
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    }),
    repository,
  });

describe("owner budget API", () => {
  it("reads and atomically audits a valid budget update", async () => {
    const { app, repository } = authorizedApp();
    const initial = await app.request("/v1/settings/budgets");
    expect(await initial.json()).toMatchObject({
      ...DEFAULT_CLOUD_COST_POLICY,
      pricingCatalogVerifiedAt: "2026-08-07T00:00:00.000Z",
    });

    const updatedPolicy = {
      ...DEFAULT_CLOUD_COST_POLICY,
      nonAi: { mode: "included-fraction" as const, fraction: 0.9 },
      ai: { monthlyOverageUsd: 10 },
    };
    const update = await app.request("/v1/settings/budgets", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "budget-update:1",
      },
      body: JSON.stringify(updatedPolicy),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual(updatedPolicy);
    expect(repository.audits()).toHaveLength(1);

    await app.request("/v1/settings/budgets", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "budget-update:1",
      },
      body: JSON.stringify(updatedPolicy),
    });
    expect(repository.audits()).toHaveLength(1);
  });

  it("accepts unlimited billing without changing technical safety contracts", async () => {
    const { app } = authorizedApp();
    const response = await app.request("/v1/settings/budgets", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "budget-update:unlimited",
      },
      body: JSON.stringify({
        ...DEFAULT_CLOUD_COST_POLICY,
        nonAi: { mode: "unlimited" },
        ai: { monthlyOverageUsd: null },
      }),
    });
    expect(response.status).toBe(200);
  });

  it("returns 409 when an idempotency key is reused with another policy", async () => {
    const { app } = authorizedApp();
    const request = (fraction: number) => app.request("/v1/settings/budgets", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "budget-update:conflict",
      },
      body: JSON.stringify({
        ...DEFAULT_CLOUD_COST_POLICY,
        nonAi: { mode: "included-fraction", fraction },
      }),
    });
    expect((await request(0.7)).status).toBe(200);
    expect((await request(0.8)).status).toBe(409);
  });

  it("requires owner authorization and idempotency", async () => {
    const denied = createAssistantApp({
      authorizeOwner: () => Promise.resolve({ outcome: "denied" as const }),
      costPolicies: new InMemoryCostPolicyRepository(),
    });
    expect((await denied.request("/v1/settings/budgets")).status).toBe(403);
    const { app } = authorizedApp();
    expect(
      (await app.request("/v1/settings/budgets", { method: "PATCH" })).status,
    ).toBe(400);
  });
});
