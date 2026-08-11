import { PRICE_CATALOG } from "@opap/cost-control";

const DOWNSTREAM_LIMITS = {
  "public-cache-miss": 500_000,
  "delegated-query": 100_000,
  "delegated-subject": 500,
  "owner-stateful-operation": 50_000,
} as const;

type DownstreamResource = keyof typeof DOWNSTREAM_LIMITS;

type ReserveRequest = {
  action: "reserve";
  deploymentId: string;
  reservationId: string;
  idempotencyKey: string;
  scopeId: string;
  resource: DownstreamResource;
  amount: number;
  period: string;
  expiresAt: string;
};

type SettleRequest = {
  action: "settle";
  deploymentId: string;
  reservationId: string;
  actualAmount: number;
};

type ReleaseRequest = {
  action: "release" | "release-ai";
  deploymentId: string;
  reservationId: string;
};

type AiReserveRequest = {
  action: "reserve-ai";
  deploymentId: string;
  reservationId: string;
  idempotencyKey: string;
  scopeId: string;
  day: string;
  month: string;
  neurons: number;
  monthlyOverageMicros: number | null;
  expiresAt: string;
};

type AiSettleRequest = {
  action: "settle-ai";
  deploymentId: string;
  reservationId: string;
  actualNeurons: number;
};

type QuotaRequest = ReserveRequest | SettleRequest | ReleaseRequest |
  AiReserveRequest | AiSettleRequest;

type ReservationRow = {
  reservation_id: string;
  amount: number;
  status: string;
  period: string;
  expires_at: string;
  scope_id: string;
  resource: DownstreamResource;
};

type UsageRow = { used: number; reserved: number };

type AiReservationRow = {
  reservation_id: string;
  idempotency_key: string;
  scope_id: string;
  day: string;
  month: string;
  neurons: number;
  free_neurons: number;
  overage_micros: number;
  status: string;
  expires_at: string;
};

const firstRow = <T>(rows: Iterable<T>): T | undefined => {
  for (const row of rows) return row;
  return undefined;
};

export class QuotaDurableObject {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_rollups (
        deployment_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        period TEXT NOT NULL,
        resource TEXT NOT NULL,
        used REAL NOT NULL DEFAULT 0,
        reserved REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, scope_id, period, resource)
      );
      CREATE TABLE IF NOT EXISTS reservations (
        deployment_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        period TEXT NOT NULL,
        amount REAL NOT NULL,
        actual_amount REAL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, reservation_id),
        UNIQUE (deployment_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS reservations_expiry
        ON reservations(deployment_id, status, expires_at);
      CREATE TABLE IF NOT EXISTS ai_daily_usage (
        deployment_id TEXT NOT NULL,
        day TEXT NOT NULL,
        used_neurons REAL NOT NULL DEFAULT 0,
        reserved_neurons REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, day)
      );
      CREATE TABLE IF NOT EXISTS ai_monthly_usage (
        deployment_id TEXT NOT NULL,
        month TEXT NOT NULL,
        used_micros REAL NOT NULL DEFAULT 0,
        reserved_micros REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, month)
      );
      CREATE TABLE IF NOT EXISTS ai_reservations (
        deployment_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        neurons REAL NOT NULL,
        free_neurons REAL NOT NULL,
        overage_micros REAL NOT NULL,
        actual_neurons REAL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, reservation_id),
        UNIQUE (deployment_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS ai_reservations_expiry
        ON ai_reservations(deployment_id, status, expires_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/usage") {
      return this.#usage(request);
    }
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });
    let input: QuotaRequest;
    try {
      input = await request.json();
    } catch {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (input.action === "reserve") return this.#reserve(input);
    if (input.action === "settle") return this.#settle(input);
    if (input.action === "release") return this.#release(input);
    if (input.action === "release-ai") return this.#releaseAi(input);
    if (input.action === "reserve-ai") return this.#reserveAi(input);
    if (input.action === "settle-ai") return this.#settleAi(input);
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }

  #reserve(input: ReserveRequest): Response {
    if (
      !(input.resource in DOWNSTREAM_LIMITS) ||
      !input.scopeId ||
      !Number.isFinite(input.amount) ||
      input.amount <= 0
    ) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const now = new Date().toISOString();
    this.#reapExpired(input.deploymentId, now);
    const existing = firstRow(this.#state.storage.sql
      .exec<ReservationRow>(
        `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
         FROM reservations
         WHERE deployment_id = ? AND idempotency_key = ?`,
        input.deploymentId,
        input.idempotencyKey,
      ));
    if (existing) {
      return existing.amount === input.amount &&
        existing.period === input.period &&
        existing.scope_id === input.scopeId &&
        existing.resource === input.resource
        ? Response.json({ reservationId: existing.reservation_id, status: existing.status })
        : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
    }

    this.#state.storage.sql.exec(
      `INSERT OR IGNORE INTO usage_rollups
       (deployment_id, scope_id, period, resource, used, reserved, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      input.deploymentId,
      input.scopeId,
      input.period,
      input.resource,
      now,
    );
    const usage = firstRow(this.#state.storage.sql
      .exec<UsageRow>(
        `SELECT used, reserved FROM usage_rollups
         WHERE deployment_id = ? AND scope_id = ?
           AND period = ? AND resource = ?`,
        input.deploymentId,
        input.scopeId,
        input.period,
        input.resource,
      ));
    if (!usage) return Response.json({ code: "METERING_UNAVAILABLE" }, { status: 503 });
    if (usage.used + usage.reserved + input.amount > DOWNSTREAM_LIMITS[input.resource]) {
      return Response.json({ code: "BUDGET_HARD_LIMIT_REACHED" }, { status: 429 });
    }
    this.#state.storage.sql.exec(
      `INSERT INTO reservations
       (deployment_id, reservation_id, idempotency_key, scope_id, resource, period, amount, status,
        expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      input.deploymentId,
      input.reservationId,
      input.idempotencyKey,
      input.scopeId,
      input.resource,
      input.period,
      input.amount,
      input.expiresAt,
      now,
      now,
    );
    this.#state.storage.sql.exec(
      `UPDATE usage_rollups SET reserved = reserved + ?, updated_at = ?
       WHERE deployment_id = ? AND scope_id = ?
         AND period = ? AND resource = ?`,
      input.amount,
      now,
      input.deploymentId,
      input.scopeId,
      input.period,
      input.resource,
    );
    return Response.json({ reservationId: input.reservationId, status: "active" });
  }

  #settle(input: SettleRequest): Response {
    if (!Number.isFinite(input.actualAmount) || input.actualAmount < 0) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const reservation = firstRow(this.#state.storage.sql
      .exec<ReservationRow>(
        `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
         FROM reservations
         WHERE deployment_id = ? AND reservation_id = ?`,
        input.deploymentId,
        input.reservationId,
      ));
    if (!reservation) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (reservation.status === "settled") {
      return Response.json({ reservationId: reservation.reservation_id, status: "settled" });
    }
    if (reservation.status !== "active") {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    this.#state.storage.sql.exec(
      `UPDATE usage_rollups
       SET reserved = MAX(0, reserved - ?), used = used + ?, updated_at = ?
       WHERE deployment_id = ? AND scope_id = ?
         AND period = ? AND resource = ?`,
      reservation.amount,
      input.actualAmount,
      now,
      input.deploymentId,
      reservation.scope_id,
      reservation.period,
      reservation.resource,
    );
    this.#state.storage.sql.exec(
      `UPDATE reservations SET status = 'settled', actual_amount = ?, updated_at = ?
       WHERE deployment_id = ? AND reservation_id = ?`,
      input.actualAmount,
      now,
      input.deploymentId,
      input.reservationId,
    );
    return Response.json({ reservationId: input.reservationId, status: "settled" });
  }

  #release(input: ReleaseRequest): Response {
    const reservation = firstRow(this.#state.storage.sql
      .exec<ReservationRow>(
        `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
         FROM reservations WHERE deployment_id = ? AND reservation_id = ?`,
        input.deploymentId,
        input.reservationId,
      ));
    if (!reservation) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (reservation.status === "released") {
      return Response.json({ reservationId: reservation.reservation_id, status: "released" });
    }
    if (reservation.status !== "active") {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    this.#state.storage.sql.exec(
      `UPDATE usage_rollups SET reserved = MAX(0, reserved - ?), updated_at = ?
       WHERE deployment_id = ? AND scope_id = ? AND period = ? AND resource = ?`,
      reservation.amount, now, input.deploymentId, reservation.scope_id,
      reservation.period, reservation.resource,
    );
    this.#state.storage.sql.exec(
      `UPDATE reservations SET status = 'released', updated_at = ?
       WHERE deployment_id = ? AND reservation_id = ?`,
      now, input.deploymentId, input.reservationId,
    );
    return Response.json({ reservationId: reservation.reservation_id, status: "released" });
  }

  #reserveAi(input: AiReserveRequest): Response {
    if (
      !input.deploymentId || !input.scopeId || !/^\d{4}-\d{2}-\d{2}$/u.test(input.day) ||
      !/^\d{4}-\d{2}$/u.test(input.month) || !input.day.startsWith(input.month) ||
      !Number.isFinite(input.neurons) || input.neurons <= 0 ||
      (input.monthlyOverageMicros !== null &&
        (!Number.isFinite(input.monthlyOverageMicros) || input.monthlyOverageMicros < 0))
    ) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const now = new Date().toISOString();
    this.#reapExpiredAi(input.deploymentId, now);
    const existing = firstRow(this.#state.storage.sql.exec<AiReservationRow>(
      `SELECT reservation_id, idempotency_key, scope_id, day, month, neurons,
              free_neurons, overage_micros, status, expires_at
       FROM ai_reservations WHERE deployment_id = ? AND idempotency_key = ?`,
      input.deploymentId, input.idempotencyKey,
    ));
    if (existing) {
      return existing.neurons === input.neurons && existing.day === input.day &&
        existing.month === input.month && existing.scope_id === input.scopeId
        ? Response.json({
            reservationId: existing.reservation_id,
            status: existing.status,
            neurons: existing.neurons,
            overageMicros: existing.overage_micros,
          })
        : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
    }
    this.#state.storage.sql.exec(
      `INSERT OR IGNORE INTO ai_daily_usage
       (deployment_id, day, used_neurons, reserved_neurons, updated_at)
       VALUES (?, ?, 0, 0, ?)`, input.deploymentId, input.day, now,
    );
    this.#state.storage.sql.exec(
      `INSERT OR IGNORE INTO ai_monthly_usage
       (deployment_id, month, used_micros, reserved_micros, updated_at)
       VALUES (?, ?, 0, 0, ?)`, input.deploymentId, input.month, now,
    );
    const daily = firstRow(this.#state.storage.sql.exec<{
      used_neurons: number; reserved_neurons: number;
    }>(
      `SELECT used_neurons, reserved_neurons FROM ai_daily_usage
       WHERE deployment_id = ? AND day = ?`, input.deploymentId, input.day,
    ));
    const monthly = firstRow(this.#state.storage.sql.exec<{
      used_micros: number; reserved_micros: number;
    }>(
      `SELECT used_micros, reserved_micros FROM ai_monthly_usage
       WHERE deployment_id = ? AND month = ?`, input.deploymentId, input.month,
    ));
    if (!daily || !monthly) {
      return Response.json({ code: "METERING_UNAVAILABLE" }, { status: 503 });
    }
    const freeRemaining = Math.max(
      0,
      PRICE_CATALOG.workersAi.freeNeuronsPerDay - daily.used_neurons - daily.reserved_neurons,
    );
    const freeNeurons = Math.min(freeRemaining, input.neurons);
    const overageMicros = (input.neurons - freeNeurons) *
      PRICE_CATALOG.workersAi.microsPerNeuron;
    if (input.monthlyOverageMicros !== null &&
      monthly.used_micros + monthly.reserved_micros + overageMicros >
        input.monthlyOverageMicros) {
      return Response.json({ code: "AI_SPEND_LIMIT_REACHED" }, { status: 429 });
    }
    this.#state.storage.sql.exec(
      `INSERT INTO ai_reservations
       (deployment_id, reservation_id, idempotency_key, scope_id, day, month, neurons,
        free_neurons, overage_micros, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      input.deploymentId, input.reservationId, input.idempotencyKey, input.scopeId,
      input.day, input.month, input.neurons, freeNeurons, overageMicros,
      input.expiresAt, now, now,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_daily_usage SET reserved_neurons = reserved_neurons + ?, updated_at = ?
       WHERE deployment_id = ? AND day = ?`,
      input.neurons, now, input.deploymentId, input.day,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_monthly_usage SET reserved_micros = reserved_micros + ?, updated_at = ?
       WHERE deployment_id = ? AND month = ?`,
      overageMicros, now, input.deploymentId, input.month,
    );
    return Response.json({
      reservationId: input.reservationId,
      status: "active",
      neurons: input.neurons,
      overageMicros,
    });
  }

  #settleAi(input: AiSettleRequest): Response {
    if (!Number.isFinite(input.actualNeurons) || input.actualNeurons < 0) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const reservation = firstRow(this.#state.storage.sql.exec<AiReservationRow>(
      `SELECT reservation_id, idempotency_key, scope_id, day, month, neurons,
              free_neurons, overage_micros, status, expires_at
       FROM ai_reservations WHERE deployment_id = ? AND reservation_id = ?`,
      input.deploymentId, input.reservationId,
    ));
    if (!reservation) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (reservation.status === "settled") {
      return Response.json({ reservationId: reservation.reservation_id, status: "settled" });
    }
    if (reservation.status !== "active" || input.actualNeurons > reservation.neurons) {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    const paidNeurons = Math.max(0, input.actualNeurons - reservation.free_neurons);
    const actualMicros = paidNeurons * PRICE_CATALOG.workersAi.microsPerNeuron;
    this.#state.storage.sql.exec(
      `UPDATE ai_daily_usage
       SET reserved_neurons = MAX(0, reserved_neurons - ?),
           used_neurons = used_neurons + ?, updated_at = ?
       WHERE deployment_id = ? AND day = ?`,
      reservation.neurons, input.actualNeurons, now, input.deploymentId, reservation.day,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_monthly_usage
       SET reserved_micros = MAX(0, reserved_micros - ?),
           used_micros = used_micros + ?, updated_at = ?
       WHERE deployment_id = ? AND month = ?`,
      reservation.overage_micros, actualMicros, now, input.deploymentId, reservation.month,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_reservations SET status = 'settled', actual_neurons = ?, updated_at = ?
       WHERE deployment_id = ? AND reservation_id = ?`,
      input.actualNeurons, now, input.deploymentId, input.reservationId,
    );
    return Response.json({
      reservationId: reservation.reservation_id,
      status: "settled",
      actualNeurons: input.actualNeurons,
      actualOverageMicros: actualMicros,
    });
  }

  #releaseAi(input: ReleaseRequest): Response {
    const reservation = firstRow(this.#state.storage.sql.exec<AiReservationRow>(
      `SELECT reservation_id, idempotency_key, scope_id, day, month, neurons,
              free_neurons, overage_micros, status, expires_at
       FROM ai_reservations WHERE deployment_id = ? AND reservation_id = ?`,
      input.deploymentId, input.reservationId,
    ));
    if (!reservation) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (reservation.status === "released") {
      return Response.json({ reservationId: reservation.reservation_id, status: "released" });
    }
    if (reservation.status !== "active") {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    this.#state.storage.sql.exec(
      `UPDATE ai_daily_usage SET reserved_neurons = MAX(0, reserved_neurons - ?), updated_at = ?
       WHERE deployment_id = ? AND day = ?`,
      reservation.neurons, now, input.deploymentId, reservation.day,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_monthly_usage SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ?
       WHERE deployment_id = ? AND month = ?`,
      reservation.overage_micros, now, input.deploymentId, reservation.month,
    );
    this.#state.storage.sql.exec(
      `UPDATE ai_reservations SET status = 'released', updated_at = ?
       WHERE deployment_id = ? AND reservation_id = ?`,
      now, input.deploymentId, input.reservationId,
    );
    return Response.json({ reservationId: reservation.reservation_id, status: "released" });
  }

  #reapExpired(deploymentId: string, now: string): void {
    const expired = [
      ...this.#state.storage.sql.exec<ReservationRow>(
        `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
         FROM reservations
         WHERE deployment_id = ? AND status = 'active' AND expires_at <= ?`,
        deploymentId,
        now,
      ),
    ];
    for (const reservation of expired) {
      this.#state.storage.sql.exec(
        `UPDATE usage_rollups SET reserved = MAX(0, reserved - ?), updated_at = ?
         WHERE deployment_id = ? AND scope_id = ?
           AND period = ? AND resource = ?`,
        reservation.amount,
        now,
        deploymentId,
        reservation.scope_id,
        reservation.period,
        reservation.resource,
      );
      this.#state.storage.sql.exec(
        `UPDATE reservations SET status = 'expired', updated_at = ?
         WHERE deployment_id = ? AND reservation_id = ?`,
        now,
        deploymentId,
        reservation.reservation_id,
      );
    }
  }

  #reapExpiredAi(deploymentId: string, now: string): void {
    const expired = [...this.#state.storage.sql.exec<AiReservationRow>(
      `SELECT reservation_id, idempotency_key, scope_id, day, month, neurons,
              free_neurons, overage_micros, status, expires_at
       FROM ai_reservations
       WHERE deployment_id = ? AND status = 'active' AND expires_at <= ?`,
      deploymentId, now,
    )];
    for (const reservation of expired) {
      this.#state.storage.sql.exec(
        `UPDATE ai_daily_usage SET reserved_neurons = MAX(0, reserved_neurons - ?), updated_at = ?
         WHERE deployment_id = ? AND day = ?`,
        reservation.neurons, now, deploymentId, reservation.day,
      );
      this.#state.storage.sql.exec(
        `UPDATE ai_monthly_usage SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ?
         WHERE deployment_id = ? AND month = ?`,
        reservation.overage_micros, now, deploymentId, reservation.month,
      );
      this.#state.storage.sql.exec(
        `UPDATE ai_reservations SET status = 'expired', updated_at = ?
         WHERE deployment_id = ? AND reservation_id = ?`,
        now, deploymentId, reservation.reservation_id,
      );
    }
  }

  #usage(request: Request): Response {
    const url = new URL(request.url);
    const deploymentId = url.searchParams.get("deploymentId");
    const scopeId = url.searchParams.get("scopeId");
    const period = url.searchParams.get("period");
    if (!deploymentId || !scopeId || !period) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const resources = [...this.#state.storage.sql.exec<{
      resource: DownstreamResource;
      used: number;
      reserved: number;
      updated_at: string;
    }>(
      `SELECT resource, used, reserved, updated_at FROM usage_rollups
       WHERE deployment_id = ? AND scope_id = ? AND period = ? ORDER BY resource`,
      deploymentId,
      scopeId,
      period,
    )].map((record) => {
      const hardLimit = DOWNSTREAM_LIMITS[record.resource];
      const projected = record.used + record.reserved;
      return {
        resource: record.resource,
        used: record.used,
        reserved: record.reserved,
        hardLimit,
        mode: projected >= hardLimit ? "blocked" : projected >= hardLimit * 0.75 ? "degraded" : "normal",
        updatedAt: record.updated_at,
      };
    });
    const aiMonthly = firstRow(this.#state.storage.sql.exec<{
      used_micros: number; reserved_micros: number; updated_at: string;
    }>(
      `SELECT used_micros, reserved_micros, updated_at FROM ai_monthly_usage
       WHERE deployment_id = ? AND month = ?`, deploymentId, period,
    ));
    const aiDaily = firstRow(this.#state.storage.sql.exec<{
      used_neurons: number; reserved_neurons: number;
    }>(
      `SELECT COALESCE(SUM(used_neurons), 0) AS used_neurons,
              COALESCE(SUM(reserved_neurons), 0) AS reserved_neurons
       FROM ai_daily_usage WHERE deployment_id = ? AND day LIKE ?`,
      deploymentId, `${period}-%`,
    ));
    return Response.json({
      resources,
      ai: {
        resource: "workers-ai-neuron",
        used: aiDaily?.used_neurons ?? 0,
        reserved: aiDaily?.reserved_neurons ?? 0,
        overageUsedUsd: (aiMonthly?.used_micros ?? 0) / 1_000_000,
        overageReservedUsd: (aiMonthly?.reserved_micros ?? 0) / 1_000_000,
        updatedAt: aiMonthly?.updated_at,
      },
    });
  }
}

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
