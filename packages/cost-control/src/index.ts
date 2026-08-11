import {
  DEFAULT_CLOUD_COST_POLICY,
  usageReservationSchema,
  type CloudCostPolicy,
  type CostProblemCode,
  type MeteredResource,
  type UsageRecord,
  type UsageReservation,
} from "@opap/contracts";

export const PRICE_CATALOG = {
  version: "cloudflare-2026-08",
  verifiedAt: "2026-08-07T00:00:00.000Z",
  included: {
    "worker-request": 10_000_000,
    "worker-cpu-ms": 30_000_000,
    "durable-object-request": 1_000_000,
    "durable-object-duration-gb-s": 400_000,
    "durable-object-row-read": 25_000_000_000,
    "durable-object-row-write": 50_000_000,
    "durable-object-storage-gb-month": 5,
    "d1-row-read": 25_000_000_000,
    "d1-row-write": 50_000_000,
    "d1-storage-gb-month": 5,
    "r2-storage-gb-month": 10,
    "r2-class-a": 1_000_000,
    "r2-class-b": 10_000_000,
    "workers-log-event": 20_000_000,
    "container-memory-gib-hour": 25,
    "container-cpu-vcpu-minute": 375,
    "container-disk-gb-hour": 200,
  },
  workersAi: {
    freeNeuronsPerDay: 10_000,
    microsPerNeuron: 11,
  },
} as const;

export type NonAiMeteredResource = keyof typeof PRICE_CATALOG.included;

export type ResourceBudget = {
  softLimit: number | null;
  hardLimit: number | null;
};

export const DEFAULT_SOFT_TO_HARD_RATIO = 0.75;

export function budgetFor(
  resource: NonAiMeteredResource,
  policy: CloudCostPolicy = DEFAULT_CLOUD_COST_POLICY,
): ResourceBudget {
  if (policy.nonAi.mode === "unlimited") {
    return { softLimit: null, hardLimit: null };
  }
  const hardLimit = PRICE_CATALOG.included[resource] * policy.nonAi.fraction;
  return { softLimit: hardLimit * DEFAULT_SOFT_TO_HARD_RATIO, hardLimit };
}

export type CatalogStage = "stable" | "preview" | "beta";

export type CatalogAssessment = {
  stale: boolean;
  enabled: boolean;
  warning?: CostProblemCode;
};

export function assessPricingCatalog(
  stage: CatalogStage,
  now: Date,
  verifiedAt = new Date(PRICE_CATALOG.verifiedAt),
): CatalogAssessment {
  const stale = now.getTime() - verifiedAt.getTime() > 31 * 24 * 60 * 60 * 1_000;
  if (!stale) return { stale: false, enabled: true };
  return {
    stale: true,
    enabled: stage === "stable",
    warning: "PRICING_CATALOG_STALE",
  };
}

export class CostControlError extends Error {
  readonly code: CostProblemCode;

  constructor(code: CostProblemCode, message: string) {
    super(message);
    this.name = "CostControlError";
    this.code = code;
  }
}

type StoredReservation = UsageReservation & {
  status: "active" | "settled" | "released" | "expired";
  actualAmount?: number;
};

const usageKey = (resource: MeteredResource, period: string): string =>
  `${resource}\u0000${period}`;

const fingerprint = (input: UsageReservation): string =>
  JSON.stringify([
    input.resource,
    input.period,
    input.amount,
    input.taskId ?? null,
  ]);

export class InMemoryQuotaLedger {
  readonly #policy: CloudCostPolicy;
  readonly #usage = new Map<string, { used: number; reserved: number }>();
  readonly #reservations = new Map<string, StoredReservation>();
  readonly #idempotency = new Map<string, { reservationId: string; fingerprint: string }>();

  constructor(policy: CloudCostPolicy = DEFAULT_CLOUD_COST_POLICY) {
    this.#policy = policy;
  }

  reserve(inputValue: UsageReservation, now = new Date()): UsageReservation {
    const input = usageReservationSchema.parse(inputValue);
    this.reapExpired(now);
    const existingIdempotency = this.#idempotency.get(input.idempotencyKey);
    if (existingIdempotency) {
      if (existingIdempotency.fingerprint !== fingerprint(input)) {
        throw new Error("Idempotency key was reused with different reservation input");
      }
      const existing = this.#reservations.get(existingIdempotency.reservationId);
      if (!existing) throw new Error("Reservation index is inconsistent");
      return usageReservationSchema.parse(existing);
    }

    if (input.resource === "workers-ai-neuron") {
      throw new TypeError("Workers AI reservations require AiSpendLedger");
    }
    const resource = input.resource;
    const budget = budgetFor(resource, this.#policy);
    const key = usageKey(resource, input.period);
    const usage = this.#usage.get(key) ?? { used: 0, reserved: 0 };
    const projected = usage.used + usage.reserved + input.amount;
    if (budget.hardLimit !== null && projected > budget.hardLimit) {
      const code: CostProblemCode = resource.includes("storage")
        ? "STORAGE_BUDGET_REACHED"
        : "BUDGET_HARD_LIMIT_REACHED";
      throw new CostControlError(code, `Budget exceeded for ${resource}`);
    }

    const stored: StoredReservation = { ...input, status: "active" };
    this.#reservations.set(input.reservationId, stored);
    this.#idempotency.set(input.idempotencyKey, {
      reservationId: input.reservationId,
      fingerprint: fingerprint(input),
    });
    this.#usage.set(key, { ...usage, reserved: usage.reserved + input.amount });
    return input;
  }

  settle(reservationId: string, actualAmount: number): void {
    if (!Number.isFinite(actualAmount) || actualAmount < 0) {
      throw new RangeError("Actual usage must be a non-negative finite number");
    }
    const reservation = this.#activeReservation(reservationId);
    const key = usageKey(reservation.resource, reservation.period);
    const usage = this.#usage.get(key);
    if (!usage) throw new Error("Usage rollup is missing");
    usage.reserved = Math.max(0, usage.reserved - reservation.amount);
    usage.used += actualAmount;
    reservation.status = "settled";
    reservation.actualAmount = actualAmount;
  }

  release(reservationId: string): void {
    const reservation = this.#activeReservation(reservationId);
    this.#releaseReservation(reservation, "released");
  }

  reapExpired(now = new Date()): number {
    let reaped = 0;
    for (const reservation of this.#reservations.values()) {
      if (
        reservation.status === "active" &&
        Date.parse(reservation.expiresAt) <= now.getTime()
      ) {
        this.#releaseReservation(reservation, "expired");
        reaped += 1;
      }
    }
    return reaped;
  }

  usage(resource: NonAiMeteredResource, period: string): UsageRecord {
    const values = this.#usage.get(usageKey(resource, period)) ?? {
      used: 0,
      reserved: 0,
    };
    const budget = budgetFor(resource, this.#policy);
    const projected = values.used + values.reserved;
    const mode =
      budget.hardLimit === null
        ? "unlimited"
        : projected >= budget.hardLimit
          ? "blocked"
          : budget.softLimit !== null && projected >= budget.softLimit
            ? "degraded"
            : "normal";
    return { resource, period, ...values, ...budget, mode };
  }

  #activeReservation(reservationId: string): StoredReservation {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new Error("Reservation not found");
    if (reservation.status !== "active") {
      throw new Error(`Reservation is ${reservation.status}`);
    }
    return reservation;
  }

  #releaseReservation(
    reservation: StoredReservation,
    status: "released" | "expired",
  ): void {
    const usage = this.#usage.get(usageKey(reservation.resource, reservation.period));
    if (!usage) throw new Error("Usage rollup is missing");
    usage.reserved = Math.max(0, usage.reserved - reservation.amount);
    reservation.status = status;
  }
}

type AiReservation = {
  reservationId: string;
  idempotencyKey: string;
  day: string;
  month: string;
  neurons: number;
  freeNeurons: number;
  overageMicros: number;
  expiresAt: string;
  status: "active" | "settled" | "released" | "expired";
};

export class InMemoryAiSpendLedger {
  readonly #monthlyOverageMicros: number | null;
  readonly #daily = new Map<string, { used: number; reserved: number }>();
  readonly #monthly = new Map<string, { usedMicros: number; reservedMicros: number }>();
  readonly #reservations = new Map<string, AiReservation>();
  readonly #idempotency = new Map<string, string>();

  constructor(monthlyOverageUsd: number | null = 5) {
    this.#monthlyOverageMicros =
      monthlyOverageUsd === null ? null : Math.round(monthlyOverageUsd * 1_000_000);
  }

  reserve(input: {
    reservationId: string;
    idempotencyKey: string;
    day: string;
    month: string;
    neurons: number;
    expiresAt: string;
  }, now = new Date()): AiReservation {
    this.reapExpired(now);
    const existingId = this.#idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.#reservations.get(existingId);
      if (!existing) throw new Error("AI reservation index is inconsistent");
      if (existing.neurons !== input.neurons || existing.day !== input.day) {
        throw new Error("Idempotency key was reused with different AI reservation input");
      }
      return existing;
    }
    if (!Number.isFinite(input.neurons) || input.neurons <= 0) {
      throw new RangeError("Neuron reservation must be positive and finite");
    }
    const daily = this.#daily.get(input.day) ?? { used: 0, reserved: 0 };
    const freeRemaining = Math.max(
      0,
      PRICE_CATALOG.workersAi.freeNeuronsPerDay - daily.used - daily.reserved,
    );
    const freeNeurons = Math.min(freeRemaining, input.neurons);
    const overageMicros =
      (input.neurons - freeNeurons) * PRICE_CATALOG.workersAi.microsPerNeuron;
    const monthly = this.#monthly.get(input.month) ?? {
      usedMicros: 0,
      reservedMicros: 0,
    };
    if (
      this.#monthlyOverageMicros !== null &&
      monthly.usedMicros + monthly.reservedMicros + overageMicros >
        this.#monthlyOverageMicros
    ) {
      throw new CostControlError("AI_SPEND_LIMIT_REACHED", "AI monthly spend limit reached");
    }
    const reservation: AiReservation = {
      ...input,
      freeNeurons,
      overageMicros,
      status: "active",
    };
    daily.reserved += input.neurons;
    monthly.reservedMicros += overageMicros;
    this.#daily.set(input.day, daily);
    this.#monthly.set(input.month, monthly);
    this.#reservations.set(input.reservationId, reservation);
    this.#idempotency.set(input.idempotencyKey, input.reservationId);
    return reservation;
  }

  settle(reservationId: string, actualNeurons: number): void {
    if (!Number.isFinite(actualNeurons) || actualNeurons < 0) {
      throw new RangeError("Actual neurons must be non-negative and finite");
    }
    const reservation = this.#active(reservationId);
    const daily = this.#daily.get(reservation.day);
    const monthly = this.#monthly.get(reservation.month);
    if (!daily || !monthly) throw new Error("AI usage rollup is missing");
    daily.reserved = Math.max(0, daily.reserved - reservation.neurons);
    daily.used += actualNeurons;
    monthly.reservedMicros = Math.max(
      0,
      monthly.reservedMicros - reservation.overageMicros,
    );
    const paidNeurons = Math.max(0, actualNeurons - reservation.freeNeurons);
    monthly.usedMicros += paidNeurons * PRICE_CATALOG.workersAi.microsPerNeuron;
    reservation.status = "settled";
  }

  release(reservationId: string): void {
    this.#release(this.#active(reservationId), "released");
  }

  reapExpired(now = new Date()): number {
    let count = 0;
    for (const reservation of this.#reservations.values()) {
      if (
        reservation.status === "active" &&
        Date.parse(reservation.expiresAt) <= now.getTime()
      ) {
        this.#release(reservation, "expired");
        count += 1;
      }
    }
    return count;
  }

  monthlyUsageMicros(month: string): number {
    const value = this.#monthly.get(month);
    return (value?.usedMicros ?? 0) + (value?.reservedMicros ?? 0);
  }

  #active(reservationId: string): AiReservation {
    const value = this.#reservations.get(reservationId);
    if (!value) throw new Error("AI reservation not found");
    if (value.status !== "active") throw new Error(`AI reservation is ${value.status}`);
    return value;
  }

  #release(
    reservation: AiReservation,
    status: "released" | "expired",
  ): void {
    const daily = this.#daily.get(reservation.day);
    const monthly = this.#monthly.get(reservation.month);
    if (!daily || !monthly) throw new Error("AI usage rollup is missing");
    daily.reserved = Math.max(0, daily.reserved - reservation.neurons);
    monthly.reservedMicros = Math.max(
      0,
      monthly.reservedMicros - reservation.overageMicros,
    );
    reservation.status = status;
  }
}

export const SANDBOX_LIMITS = {
  instanceType: "lite",
  keepAlive: false,
  sleepAfterSeconds: 30,
  timeoutSeconds: 30,
  outputBytes: 1_048_576,
  concurrency: 2,
} as const;

export function estimateSandboxReservation(executionSeconds: number): Readonly<
  Record<
    | "container-memory-gib-hour"
    | "container-cpu-vcpu-minute"
    | "container-disk-gb-hour",
    number
  >
> {
  if (!Number.isFinite(executionSeconds) || executionSeconds <= 0) {
    throw new RangeError("Sandbox execution time must be positive and finite");
  }
  if (executionSeconds > SANDBOX_LIMITS.timeoutSeconds) {
    throw new RangeError("Sandbox execution exceeds the 30 second safety limit");
  }
  const provisionedSeconds = executionSeconds + SANDBOX_LIMITS.sleepAfterSeconds;
  return {
    "container-memory-gib-hour": (0.25 * provisionedSeconds) / 3_600,
    "container-cpu-vcpu-minute": ((1 / 16) * executionSeconds) / 60,
    "container-disk-gb-hour": (2 * provisionedSeconds) / 3_600,
  };
}

export type BudgetChangeAudit = {
  principalId: string;
  requestId: string;
  idempotencyKey: string;
  occurredAt: string;
};

export interface CostPolicyRepository {
  get(): Promise<CloudCostPolicy>;
  update(policy: CloudCostPolicy, audit: BudgetChangeAudit): Promise<CloudCostPolicy>;
  usage(period: string): Promise<readonly UsageRecord[]>;
}

export class CostPolicyConflictError extends Error {
  constructor() {
    super("Idempotency key was reused with a different budget policy");
    this.name = "CostPolicyConflictError";
  }
}

export class InMemoryCostPolicyRepository implements CostPolicyRepository {
  #policy: CloudCostPolicy;
  readonly #usageRecords: UsageRecord[];
  readonly #audits: BudgetChangeAudit[] = [];
  readonly #updates = new Map<string, CloudCostPolicy>();

  constructor(
    policy: CloudCostPolicy = DEFAULT_CLOUD_COST_POLICY,
    usageRecords: readonly UsageRecord[] = [],
  ) {
    this.#policy = policy;
    this.#usageRecords = [...usageRecords];
  }

  get(): Promise<CloudCostPolicy> {
    return Promise.resolve(this.#policy);
  }

  update(
    policy: CloudCostPolicy,
    audit: BudgetChangeAudit,
  ): Promise<CloudCostPolicy> {
    const existing = this.#updates.get(audit.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(policy)) {
        return Promise.reject(new CostPolicyConflictError());
      }
      return Promise.resolve(existing);
    }
    this.#policy = policy;
    this.#updates.set(audit.idempotencyKey, policy);
    this.#audits.push(audit);
    return Promise.resolve(policy);
  }

  usage(period: string): Promise<readonly UsageRecord[]> {
    return Promise.resolve(this.#usageRecords.filter((record) => record.period === period));
  }

  audits(): readonly BudgetChangeAudit[] {
    return this.#audits;
  }
}
