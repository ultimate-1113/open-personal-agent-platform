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

type BatchReservationItem = Omit<ReserveRequest, "action" | "deploymentId" | "expiresAt">;

type BatchReserveRequest = {
  action: "reserve-batch";
  deploymentId: string;
  expiresAt: string;
  items: BatchReservationItem[];
};

type BatchSettleRequest = {
  action: "settle-batch";
  deploymentId: string;
  items: { reservationId: string; actualAmount: number }[];
};

type BatchReleaseRequest = {
  action: "release-batch";
  deploymentId: string;
  reservationIds: string[];
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
type SetAiPolicyRequest = { action: "set-ai-policy"; deploymentId: string;
  monthlyOverageMicros: number | null };
type ImportLegacyRequest = { action: "import-legacy"; deploymentId: string; sourceShard: string;
  usage: { scopeId: string; period: string; resource: string; used: number }[];
  aiDaily: { day: string; usedNeurons: number }[];
  aiMonthly: { month: string; usedMicros: number }[] };

type QuotaRequest = ReserveRequest | BatchReserveRequest | BatchSettleRequest |
  BatchReleaseRequest | SettleRequest | ReleaseRequest |
  AiReserveRequest | AiSettleRequest | SetAiPolicyRequest | ImportLegacyRequest;

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
      CREATE TABLE IF NOT EXISTS ai_budget_policies (
        deployment_id TEXT PRIMARY KEY,
        monthly_overage_micros REAL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_import_markers (
        deployment_id TEXT NOT NULL,
        source_shard TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (deployment_id, source_shard)
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/usage") {
      return this.#usage(request);
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/export-legacy") {
      return this.#exportLegacy(request);
    }
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });
    let input: QuotaRequest;
    try {
      input = await request.json();
    } catch {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (input.action === "reserve") return this.#reserve(input);
    if (input.action === "reserve-batch") return this.#reserveBatch(input);
    if (input.action === "settle-batch") return this.#settleBatch(input);
    if (input.action === "release-batch") return this.#releaseBatch(input);
    if (input.action === "settle") return this.#settle(input);
    if (input.action === "release") return this.#release(input);
    if (input.action === "release-ai") return this.#releaseAi(input);
    if (input.action === "reserve-ai") return this.#reserveAi(input);
    if (input.action === "settle-ai") return this.#settleAi(input);
    if (input.action === "set-ai-policy") return this.#setAiPolicy(input);
    if (input.action === "import-legacy") return this.#importLegacy(input);
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

  #reserveBatch(input: BatchReserveRequest): Response {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10 ||
      new Set(input.items.map((item) => item.reservationId)).size !== input.items.length ||
      new Set(input.items.map((item) => item.idempotencyKey)).size !== input.items.length ||
      input.items.some((item) => !(item.resource in DOWNSTREAM_LIMITS) || !item.scopeId ||
        !Number.isFinite(item.amount) || item.amount <= 0)) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const now = new Date().toISOString();
    this.#reapExpired(input.deploymentId, now);
    const existing = input.items.map((item) => firstRow(this.#state.storage.sql.exec<ReservationRow>(
      `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
       FROM reservations WHERE deployment_id = ? AND idempotency_key = ?`,
      input.deploymentId, item.idempotencyKey,
    )));
    if (existing.some(Boolean)) {
      const allMatch = existing.every((row, index) => {
        const item = input.items[index];
        return row && item && row.reservation_id === item.reservationId && row.amount === item.amount &&
          row.period === item.period && row.scope_id === item.scopeId && row.resource === item.resource;
      });
      return allMatch
        ? Response.json({ status: "active", reservationIds: existing.map((row) => row!.reservation_id) })
        : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
    }

    const projected = new Map<string, number>();
    for (const item of input.items) {
      this.#state.storage.sql.exec(
        `INSERT OR IGNORE INTO usage_rollups
         (deployment_id, scope_id, period, resource, used, reserved, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
        input.deploymentId, item.scopeId, item.period, item.resource, now,
      );
      const usage = firstRow(this.#state.storage.sql.exec<UsageRow>(
        `SELECT used, reserved FROM usage_rollups
         WHERE deployment_id = ? AND scope_id = ? AND period = ? AND resource = ?`,
        input.deploymentId, item.scopeId, item.period, item.resource,
      ));
      if (!usage) return Response.json({ code: "METERING_UNAVAILABLE" }, { status: 503 });
      const key = `${item.scopeId}\u0000${item.period}\u0000${item.resource}`;
      const next = (projected.get(key) ?? usage.used + usage.reserved) + item.amount;
      if (next > DOWNSTREAM_LIMITS[item.resource]) {
        return Response.json({ code: "BUDGET_HARD_LIMIT_REACHED" }, { status: 429 });
      }
      projected.set(key, next);
    }

    for (const item of input.items) {
      this.#state.storage.sql.exec(
        `INSERT INTO reservations
         (deployment_id, reservation_id, idempotency_key, scope_id, resource, period, amount,
          status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        input.deploymentId, item.reservationId, item.idempotencyKey, item.scopeId, item.resource,
        item.period, item.amount, input.expiresAt, now, now,
      );
      this.#state.storage.sql.exec(
        `UPDATE usage_rollups SET reserved = reserved + ?, updated_at = ?
         WHERE deployment_id = ? AND scope_id = ? AND period = ? AND resource = ?`,
        item.amount, now, input.deploymentId, item.scopeId, item.period, item.resource,
      );
    }
    return Response.json({ status: "active", reservationIds: input.items.map((item) => item.reservationId) });
  }

  #settleBatch(input: BatchSettleRequest): Response {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10 ||
      input.items.some((item) => !item.reservationId || !Number.isFinite(item.actualAmount) ||
        item.actualAmount < 0)) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const rows = input.items.map((item) => firstRow(this.#state.storage.sql.exec<ReservationRow>(
      `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
       FROM reservations WHERE deployment_id = ? AND reservation_id = ?`,
      input.deploymentId, item.reservationId,
    )));
    if (rows.some((row) => !row)) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (rows.some((row) => row!.status !== "active" && row!.status !== "settled")) {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    input.items.forEach((item, index) => {
      const row = rows[index]!;
      if (row.status === "settled") return;
      this.#state.storage.sql.exec(
        `UPDATE usage_rollups SET reserved = MAX(0, reserved - ?), used = used + ?, updated_at = ?
         WHERE deployment_id = ? AND scope_id = ? AND period = ? AND resource = ?`,
        row.amount, item.actualAmount, now, input.deploymentId, row.scope_id, row.period, row.resource,
      );
      this.#state.storage.sql.exec(
        `UPDATE reservations SET status = 'settled', actual_amount = ?, updated_at = ?
         WHERE deployment_id = ? AND reservation_id = ?`,
        item.actualAmount, now, input.deploymentId, item.reservationId,
      );
    });
    return Response.json({ status: "settled", reservationIds: input.items.map((item) => item.reservationId) });
  }

  #releaseBatch(input: BatchReleaseRequest): Response {
    if (!Array.isArray(input.reservationIds) || input.reservationIds.length < 1 ||
      input.reservationIds.length > 10) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const rows = input.reservationIds.map((reservationId) => firstRow(
      this.#state.storage.sql.exec<ReservationRow>(
        `SELECT reservation_id, amount, status, period, expires_at, scope_id, resource
         FROM reservations WHERE deployment_id = ? AND reservation_id = ?`,
        input.deploymentId, reservationId,
      ),
    ));
    if (rows.some((row) => !row)) return Response.json({ code: "RESERVATION_NOT_FOUND" }, { status: 404 });
    if (rows.some((row) => row!.status !== "active" && row!.status !== "released")) {
      return Response.json({ code: "RESERVATION_NOT_ACTIVE" }, { status: 409 });
    }
    const now = new Date().toISOString();
    rows.forEach((row, index) => {
      if (row!.status === "released") return;
      this.#state.storage.sql.exec(
        `UPDATE usage_rollups SET reserved = MAX(0, reserved - ?), updated_at = ?
         WHERE deployment_id = ? AND scope_id = ? AND period = ? AND resource = ?`,
        row!.amount, now, input.deploymentId, row!.scope_id, row!.period, row!.resource,
      );
      this.#state.storage.sql.exec(
        `UPDATE reservations SET status = 'released', updated_at = ?
         WHERE deployment_id = ? AND reservation_id = ?`,
        now, input.deploymentId, input.reservationIds[index],
      );
    });
    return Response.json({ status: "released", reservationIds: input.reservationIds });
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
    const storedPolicy = firstRow(this.#state.storage.sql.exec<{ monthly_overage_micros: number | null }>(
      "SELECT monthly_overage_micros FROM ai_budget_policies WHERE deployment_id = ?",
      input.deploymentId,
    ));
    const monthlyOverageMicros = storedPolicy ? storedPolicy.monthly_overage_micros
      : input.monthlyOverageMicros;
    if (monthlyOverageMicros !== null &&
      monthly.used_micros + monthly.reserved_micros + overageMicros >
        monthlyOverageMicros) {
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

  #setAiPolicy(input: SetAiPolicyRequest): Response {
    if (!input.deploymentId || (input.monthlyOverageMicros !== null &&
      (!Number.isFinite(input.monthlyOverageMicros) || input.monthlyOverageMicros < 0))) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    this.#state.storage.sql.exec(
      `INSERT INTO ai_budget_policies (deployment_id, monthly_overage_micros, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(deployment_id) DO UPDATE SET
       monthly_overage_micros = excluded.monthly_overage_micros, updated_at = excluded.updated_at`,
      input.deploymentId, input.monthlyOverageMicros, new Date().toISOString(),
    );
    return Response.json({ monthlyOverageMicros: input.monthlyOverageMicros });
  }

  #exportLegacy(request: Request): Response {
    const deploymentId = new URL(request.url).searchParams.get("deploymentId");
    if (!deploymentId) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    return Response.json({
      usage: [...this.#state.storage.sql.exec<{ scope_id: string; period: string; resource: string; used: number }>(
        "SELECT scope_id, period, resource, used FROM usage_rollups WHERE deployment_id = ?",
        deploymentId,
      )].map((row) => ({ scopeId: row.scope_id, period: row.period, resource: row.resource, used: row.used })),
      aiDaily: [...this.#state.storage.sql.exec<{ day: string; used_neurons: number }>(
        "SELECT day, used_neurons FROM ai_daily_usage WHERE deployment_id = ?", deploymentId,
      )].map((row) => ({ day: row.day, usedNeurons: row.used_neurons })),
      aiMonthly: [...this.#state.storage.sql.exec<{ month: string; used_micros: number }>(
        "SELECT month, used_micros FROM ai_monthly_usage WHERE deployment_id = ?", deploymentId,
      )].map((row) => ({ month: row.month, usedMicros: row.used_micros })),
    });
  }

  #importLegacy(input: ImportLegacyRequest): Response {
    if (!input.deploymentId || !["owner", "public"].includes(input.sourceShard) ||
      !Array.isArray(input.usage) || !Array.isArray(input.aiDaily) || !Array.isArray(input.aiMonthly)) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const imported = firstRow(this.#state.storage.sql.exec<{ source_shard: string }>(
      "SELECT source_shard FROM legacy_import_markers WHERE deployment_id = ? AND source_shard = ?",
      input.deploymentId, input.sourceShard,
    ));
    if (imported) return Response.json({ status: "already-imported", sourceShard: input.sourceShard });
    if (input.usage.some((row) => !(row.resource in DOWNSTREAM_LIMITS) || !row.scopeId || !row.period ||
      !Number.isFinite(row.used) || row.used < 0) || input.aiDaily.some((row) => !/^\d{4}-\d{2}-\d{2}$/u.test(row.day) ||
      !Number.isFinite(row.usedNeurons) || row.usedNeurons < 0) || input.aiMonthly.some((row) =>
      !/^\d{4}-\d{2}$/u.test(row.month) || !Number.isFinite(row.usedMicros) || row.usedMicros < 0)) {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const now = new Date().toISOString();
    for (const row of input.usage) this.#state.storage.sql.exec(
      `INSERT INTO usage_rollups (deployment_id, scope_id, period, resource, used, reserved, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(deployment_id, scope_id, period, resource)
       DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`,
      input.deploymentId, row.scopeId, row.period, row.resource, row.used, now,
    );
    for (const row of input.aiDaily) this.#state.storage.sql.exec(
      `INSERT INTO ai_daily_usage (deployment_id, day, used_neurons, reserved_neurons, updated_at)
       VALUES (?, ?, ?, 0, ?) ON CONFLICT(deployment_id, day)
       DO UPDATE SET used_neurons = used_neurons + excluded.used_neurons, updated_at = excluded.updated_at`,
      input.deploymentId, row.day, row.usedNeurons, now,
    );
    for (const row of input.aiMonthly) this.#state.storage.sql.exec(
      `INSERT INTO ai_monthly_usage (deployment_id, month, used_micros, reserved_micros, updated_at)
       VALUES (?, ?, ?, 0, ?) ON CONFLICT(deployment_id, month)
       DO UPDATE SET used_micros = used_micros + excluded.used_micros, updated_at = excluded.updated_at`,
      input.deploymentId, row.month, row.usedMicros, now,
    );
    this.#state.storage.sql.exec(
      "INSERT INTO legacy_import_markers (deployment_id, source_shard, imported_at) VALUES (?, ?, ?)",
      input.deploymentId, input.sourceShard, now,
    );
    return Response.json({ status: "imported", sourceShard: input.sourceShard });
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
