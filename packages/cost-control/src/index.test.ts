import { describe, expect, it } from "vitest";
import { DEFAULT_CLOUD_COST_POLICY, type UsageReservation } from "@opap/contracts";
import {
  assessPricingCatalog,
  budgetFor,
  estimateSandboxReservation,
  InMemoryAiSpendLedger,
  InMemoryQuotaLedger,
  PRICE_CATALOG,
  InMemoryCostPolicyRepository,
} from "./index.js";
import type { CostControlError } from "./index.js";

const reservation = (overrides: Partial<UsageReservation> = {}): UsageReservation => ({
  reservationId: "reservation:1",
  resource: "r2-class-a",
  period: "2026-08",
  amount: 1,
  expiresAt: "2026-08-07T01:00:00.000Z",
  taskId: "task:1",
  idempotencyKey: "idempotency:1",
  ...overrides,
});

describe("price catalog budgets", () => {
  it("sets every non-AI hard limit to 80 percent of the included amount", () => {
    for (const [resource, included] of Object.entries(PRICE_CATALOG.included)) {
      expect(budgetFor(resource as keyof typeof PRICE_CATALOG.included).hardLimit).toBe(
        included * 0.8,
      );
    }
  });
  it("uses 60 percent soft and 80 percent hard limits by default", () => {
    expect(budgetFor("worker-request")).toEqual({
      softLimit: 6_000_000,
      hardLimit: 8_000_000,
    });
    expect(budgetFor("container-cpu-vcpu-minute").hardLimit).toBe(300);
  });

  it("allows owner-selected fractions and unlimited metering", () => {
    expect(
      budgetFor("d1-storage-gb-month", {
        ...DEFAULT_CLOUD_COST_POLICY,
        nonAi: { mode: "included-fraction", fraction: 0.5 },
      }).hardLimit,
    ).toBe(2.5);
    expect(
      budgetFor("d1-storage-gb-month", {
        ...DEFAULT_CLOUD_COST_POLICY,
        nonAi: { mode: "unlimited" },
      }),
    ).toEqual({ softLimit: null, hardLimit: null });
  });

  it("keeps stable features enabled but disables stale beta features", () => {
    const staleDate = new Date("2026-09-08T00:00:00.000Z");
    expect(assessPricingCatalog("stable", staleDate)).toMatchObject({
      stale: true,
      enabled: true,
    });
    expect(assessPricingCatalog("beta", staleDate)).toMatchObject({
      stale: true,
      enabled: false,
      warning: "PRICING_CATALOG_STALE",
    });
  });
});

describe("budget policy updates", () => {
  it("rejects reuse of an idempotency key with a different policy", async () => {
    const repository = new InMemoryCostPolicyRepository();
    const audit = {
      principalId: "principal:owner",
      requestId: "request:1",
      idempotencyKey: "budget-key:1",
      occurredAt: "2026-08-07T00:00:00.000Z",
    };
    await repository.update(DEFAULT_CLOUD_COST_POLICY, audit);
    await expect(repository.update({
      ...DEFAULT_CLOUD_COST_POLICY,
      nonAi: { mode: "unlimited" },
    }, audit)).rejects.toThrow("different budget policy");
  });
});

describe("quota reservations", () => {
  it("reserves idempotently and settles actual usage", () => {
    const ledger = new InMemoryQuotaLedger();
    const input = reservation();
    expect(ledger.reserve(input, new Date("2026-08-07T00:00:00.000Z"))).toEqual(input);
    expect(ledger.reserve(input, new Date("2026-08-07T00:00:00.000Z"))).toEqual(input);
    ledger.settle(input.reservationId, 0.5);
    expect(ledger.usage("r2-class-a", "2026-08")).toMatchObject({
      used: 0.5,
      reserved: 0,
      mode: "normal",
    });
  });

  it("rejects a changed request using the same idempotency key", () => {
    const ledger = new InMemoryQuotaLedger();
    ledger.reserve(reservation(), new Date("2026-08-07T00:00:00.000Z"));
    expect(() => ledger.reserve(
      reservation({ reservationId: "reservation:2", amount: 2 }),
      new Date("2026-08-07T00:01:00.000Z"),
    )).toThrow(
      "different",
    );
  });

  it("does not double reserve when a retry has a newly calculated expiry", () => {
    const ledger = new InMemoryQuotaLedger();
    ledger.reserve(reservation(), new Date("2026-08-07T00:00:00.000Z"));
    expect(() => ledger.reserve(reservation({
      reservationId: "reservation:retry",
      expiresAt: "2026-08-07T02:00:00.000Z",
    }), new Date("2026-08-07T00:01:00.000Z"))).not.toThrow();
    expect(ledger.usage("r2-class-a", "2026-08").reserved).toBe(1);
  });

  it("blocks non-AI overage and reports storage separately", () => {
    const ledger = new InMemoryQuotaLedger({
      ...DEFAULT_CLOUD_COST_POLICY,
      nonAi: { mode: "included-fraction", fraction: 0.1 },
    });
    expect(() =>
      ledger.reserve(reservation({
        resource: "d1-storage-gb-month",
        amount: 0.6,
      })),
    ).toThrowError(expect.objectContaining<Partial<CostControlError>>({
      code: "STORAGE_BUDGET_REACHED",
    }));
  });

  it("reaps expired reservations without a dedicated alarm", () => {
    const ledger = new InMemoryQuotaLedger();
    ledger.reserve(reservation(), new Date("2026-08-07T00:00:00.000Z"));
    expect(ledger.reapExpired(new Date("2026-08-07T01:00:00.000Z"))).toBe(1);
    expect(ledger.usage("r2-class-a", "2026-08").reserved).toBe(0);
  });

  it("releases reservations and rejects invalid settlement", () => {
    const ledger = new InMemoryQuotaLedger();
    ledger.reserve(reservation());
    expect(() => ledger.settle("reservation:1", -1)).toThrow("non-negative");
    ledger.release("reservation:1");
    expect(ledger.usage("r2-class-a", "2026-08").reserved).toBe(0);
    expect(() => ledger.release("reservation:1")).toThrow("released");
  });
});

describe("AI spend", () => {
  it("uses the daily free allocation before monthly overage", () => {
    const ledger = new InMemoryAiSpendLedger(5);
    const first = ledger.reserve({
      reservationId: "ai:1",
      idempotencyKey: "ai-key:1",
      day: "2026-08-07",
      month: "2026-08",
      neurons: PRICE_CATALOG.workersAi.freeNeuronsPerDay,
      expiresAt: "2026-08-07T01:00:00.000Z",
    }, new Date("2026-08-07T00:00:00.000Z"));
    expect(first.overageMicros).toBe(0);
    ledger.settle(first.reservationId, first.neurons);
    const second = ledger.reserve({
      reservationId: "ai:2",
      idempotencyKey: "ai-key:2",
      day: "2026-08-07",
      month: "2026-08",
      neurons: 1_000,
      expiresAt: "2026-08-07T01:00:00.000Z",
    }, new Date("2026-08-07T00:00:00.000Z"));
    expect(second.overageMicros).toBe(11_000);
  });

  it("blocks projected AI spend above five dollars", () => {
    const ledger = new InMemoryAiSpendLedger(5);
    expect(() => ledger.reserve({
      reservationId: "ai:large",
      idempotencyKey: "ai-key:large",
      day: "2026-08-07",
      month: "2026-08",
      neurons: 500_000,
      expiresAt: "2026-08-07T01:00:00.000Z",
    }, new Date("2026-08-07T00:00:00.000Z"))).toThrowError(
      expect.objectContaining<Partial<CostControlError>>({ code: "AI_SPEND_LIMIT_REACHED" }),
    );
  });

  it("supports unlimited overage while retaining reservation validation", () => {
    const ledger = new InMemoryAiSpendLedger(null);
    expect(() => ledger.reserve({
      reservationId: "ai:invalid",
      idempotencyKey: "ai-key:invalid",
      day: "2026-08-07",
      month: "2026-08",
      neurons: 0,
      expiresAt: "2026-08-07T01:00:00.000Z",
    })).toThrow("positive");
    const input = {
      reservationId: "ai:unlimited",
      idempotencyKey: "ai-key:unlimited",
      day: "2026-08-07",
      month: "2026-08",
      neurons: 1_000_000,
      expiresAt: "2026-08-07T01:00:00.000Z",
    };
    const reserved = ledger.reserve(input, new Date("2026-08-07T00:00:00.000Z"));
    expect(ledger.reserve(input, new Date("2026-08-07T00:00:00.000Z"))).toBe(reserved);
    expect(() => ledger.reserve(
      { ...input, neurons: 2_000_000 },
      new Date("2026-08-07T00:01:00.000Z"),
    )).toThrow("different AI");
    expect(ledger.monthlyUsageMicros("2026-08")).toBeGreaterThan(0);
    expect(ledger.monthlyUsageMicros("2026-09")).toBe(0);
    ledger.release(input.reservationId);
    expect(() => ledger.release(input.reservationId)).toThrow("released");
  });

  it("reaps expired AI reservations and validates actual usage", () => {
    const ledger = new InMemoryAiSpendLedger();
    ledger.reserve({
      reservationId: "ai:expired",
      idempotencyKey: "ai-key:expired",
      day: "2026-08-07",
      month: "2026-08",
      neurons: 100,
      expiresAt: "2026-08-07T01:00:00.000Z",
    }, new Date("2026-08-07T00:00:00.000Z"));
    expect(() => ledger.settle("ai:expired", -1)).toThrow("non-negative");
    expect(ledger.reapExpired(new Date("2026-08-07T01:00:00.000Z"))).toBe(1);
    expect(() => ledger.settle("ai:expired", 100)).toThrow("expired");
  });
});

describe("sandbox reservation", () => {
  it("reserves lite memory, CPU and disk independently", () => {
    expect(estimateSandboxReservation(30)).toEqual({
      "container-memory-gib-hour": 1 / 240,
      "container-cpu-vcpu-minute": 1 / 32,
      "container-disk-gb-hour": 1 / 30,
    });
  });

  it("does not let unlimited billing disable the runtime safety limit", () => {
    expect(() => estimateSandboxReservation(0)).toThrow("positive");
    expect(() => estimateSandboxReservation(31)).toThrow("30 second safety limit");
  });
});
