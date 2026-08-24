import { appendAuditEvent, type AppendAuditEventInput } from "@opap/provenance";

type AppendAuditRpcInput = Omit<AppendAuditEventInput, "occurredAt"> & {
  occurredAt?: string;
};

type Bindings = {
  AUDIT_CHECKPOINTS: R2Bucket;
  CONTROL_DB: D1Database;
};

type StoredAuditRow = {
  event_id: string;
  principal_id: string | null;
  event_type: string;
  outcome: string;
  request_id: string;
  occurred_at: string;
  metadata_json: string;
  previous_hash: string | null;
  event_hash: string;
};

const firstRow = <T>(rows: Iterable<T>): T | undefined => {
  for (const row of rows) return row;
  return undefined;
};

export const auditOccurredAtFromRpc = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
};

const isAppendInput = (value: unknown): value is AppendAuditRpcInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["eventId", "deploymentId", "eventType", "outcome", "requestId"].every(
    (key) => typeof input[key] === "string",
  ) && typeof input["metadata"] === "object" && input["metadata"] !== null &&
    (input["occurredAt"] === undefined ||
      (typeof input["occurredAt"] === "string" &&
        auditOccurredAtFromRpc(input["occurredAt"]) !== undefined));
};

export class AuditLedger {
  readonly #state: DurableObjectState;
  readonly #sql: SqlStorage;
  readonly #env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.#state = state;
    this.#env = env;
    this.#sql = state.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        segment_date TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        principal_id TEXT,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS segments (
        segment_date TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        first_event_hash TEXT,
        last_event_hash TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at DESC, sequence DESC);
      CREATE TABLE IF NOT EXISTS schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#sql.exec(
      `INSERT INTO schema_metadata (singleton, schema_version, updated_at) VALUES (1, 2, ?)
       ON CONFLICT(singleton) DO UPDATE SET schema_version = MAX(schema_version, 2),
         updated_at = excluded.updated_at`,
      new Date().toISOString(),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/append") {
      const value: unknown = await request.json().catch(() => null);
      if (!isAppendInput(value)) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      return this.#state.blockConcurrencyWhile(() => this.#append(value));
    }
    if (request.method === "GET" && path === "/events") return this.#events();
    if (request.method === "POST" && path === "/segments/close") {
      const value: unknown = await request.json().catch(() => ({}));
      const throughDate = typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>)["throughDate"] === "string"
        ? String((value as Record<string, unknown>)["throughDate"]) : yesterdayUtc();
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(throughDate)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      return this.#state.blockConcurrencyWhile(() => this.#closeSegments(throughDate));
    }
    if (request.method === "DELETE" && path === "/segments/retention") {
      const before = new URL(request.url).searchParams.get("before");
      if (!before || !/^\d{4}-\d{2}-\d{2}$/u.test(before)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      return this.#state.blockConcurrencyWhile(() => this.#deleteClosedSegments(before));
    }
    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.#closeSegments(yesterdayUtc());
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 180);
    await this.#deleteClosedSegments(cutoff.toISOString().slice(0, 10));
    await this.#state.storage.setAlarm(nextUtcDay());
  }

  async #append(input: AppendAuditRpcInput): Promise<Response> {
    const existing = firstRow(this.#sql.exec<StoredAuditRow>(
      `SELECT event_id, principal_id, event_type, outcome, request_id, occurred_at,
              metadata_json, previous_hash, event_hash FROM events WHERE event_id = ?`,
      input.eventId,
    ));
    if (existing) return Response.json({ eventId: existing.event_id, eventHash: existing.event_hash });
    const previous = firstRow(this.#sql.exec<{ event_hash: string }>(
      `SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1`,
    ));
    const { occurredAt: occurredAtValue, ...eventInput } = input;
    const occurredAt = auditOccurredAtFromRpc(occurredAtValue);
    const event = await appendAuditEvent({
      ...eventInput,
      ...(occurredAt ? { occurredAt } : {}),
      ...(previous ? { previousHash: previous.event_hash } : {}),
    });
    let segmentDate = event.occurredAt.slice(0, 10);
    const requestedSegment = firstRow(this.#sql.exec<{ status: string }>(
      "SELECT status FROM segments WHERE segment_date = ?", segmentDate,
    ));
    // A checkpointed segment is immutable. Late events retain their occurredAt but are
    // appended to the current ingestion segment so its checkpoint remains verifiable.
    if (requestedSegment?.status === "closed") {
      segmentDate = new Date().toISOString().slice(0, 10);
    }
    this.#sql.exec(
      `INSERT OR IGNORE INTO segments (segment_date, status, created_at)
       VALUES (?, 'active', ?)`,
      segmentDate,
      event.occurredAt,
    );
    this.#sql.exec(
      `INSERT INTO events
       (event_id, segment_date, deployment_id, principal_id, event_type, outcome, request_id,
        occurred_at, metadata_json, previous_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      segmentDate,
      event.deploymentId,
      event.principalId ?? null,
      event.eventType,
      event.outcome,
      event.requestId,
      event.occurredAt,
      JSON.stringify(event.metadata),
      event.previousHash ?? null,
      event.eventHash,
    );
    this.#sql.exec(
      `UPDATE segments SET
         first_event_hash = COALESCE(first_event_hash, ?),
         last_event_hash = ?,
         event_count = event_count + 1
       WHERE segment_date = ? AND status = 'active'`,
      event.eventHash,
      event.eventHash,
      segmentDate,
    );
    const currentAlarm = await this.#state.storage.getAlarm();
    if (currentAlarm === null) await this.#state.storage.setAlarm(nextUtcDay());
    return Response.json({ eventId: event.eventId, eventHash: event.eventHash }, { status: 201 });
  }

  async #closeSegments(throughDate: string): Promise<Response> {
    const segments = [...this.#sql.exec<{
      segment_date: string; first_event_hash: string; last_event_hash: string;
      event_count: number; deployment_id: string;
    }>(
      `SELECT s.segment_date, s.first_event_hash, s.last_event_hash, s.event_count,
              MIN(e.deployment_id) AS deployment_id
       FROM segments s JOIN events e ON e.segment_date = s.segment_date
       WHERE s.status = 'active' AND s.segment_date <= ?
       GROUP BY s.segment_date, s.first_event_hash, s.last_event_hash, s.event_count
       ORDER BY s.segment_date`, throughDate,
    )];
    const closed: string[] = [];
    for (const segment of segments) {
      const checkpoint = {
        format: "opap-audit-checkpoint/v1",
        deploymentId: segment.deployment_id,
        segmentDate: segment.segment_date,
        firstEventHash: segment.first_event_hash,
        lastEventHash: segment.last_event_hash,
        eventCount: segment.event_count,
        closedAt: new Date().toISOString(),
      };
      const payload = JSON.stringify(checkpoint);
      const bytes = new TextEncoder().encode(payload);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const key = `audit/${encodeURIComponent(segment.deployment_id)}/${segment.segment_date}.json`;
      await this.#env.AUDIT_CHECKPOINTS.put(key, bytes, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { format: checkpoint.format, segmentDate: segment.segment_date },
        sha256: digest.buffer,
      });
      const stored = await this.#env.AUDIT_CHECKPOINTS.head(key);
      if (!stored) throw new Error("Audit checkpoint could not be verified");
      await this.#env.CONTROL_DB.prepare(
        `INSERT INTO audit_checkpoints
         (deployment_id, checkpoint_date, last_event_id, last_event_hash, event_count,
          r2_object_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deployment_id, checkpoint_date) DO UPDATE SET
           last_event_id = excluded.last_event_id, last_event_hash = excluded.last_event_hash,
           event_count = excluded.event_count, r2_object_key = excluded.r2_object_key,
           created_at = excluded.created_at`,
      ).bind(segment.deployment_id, segment.segment_date, `segment:${segment.segment_date}`,
        segment.last_event_hash, segment.event_count, key, checkpoint.closedAt).run();
      this.#sql.exec("UPDATE segments SET status = 'closed' WHERE segment_date = ? AND status = 'active'",
        segment.segment_date);
      closed.push(segment.segment_date);
    }
    return Response.json({ closed });
  }

  async #deleteClosedSegments(before: string): Promise<Response> {
    const segments = [...this.#sql.exec<{ segment_date: string; deployment_id: string }>(
      `SELECT s.segment_date, MIN(e.deployment_id) AS deployment_id
       FROM segments s JOIN events e ON e.segment_date = s.segment_date
       WHERE s.status = 'closed' AND s.segment_date < ? GROUP BY s.segment_date`, before,
    )];
    const deleted: string[] = [];
    for (const segment of segments) {
      const checkpoint = await this.#env.CONTROL_DB.prepare(
        `SELECT r2_object_key FROM audit_checkpoints
         WHERE deployment_id = ? AND checkpoint_date = ?`,
      ).bind(segment.deployment_id, segment.segment_date).first<{ r2_object_key: string }>();
      if (!checkpoint || !await this.#env.AUDIT_CHECKPOINTS.head(checkpoint.r2_object_key)) continue;
      this.#sql.exec("DELETE FROM events WHERE segment_date = ?", segment.segment_date);
      this.#sql.exec("DELETE FROM segments WHERE segment_date = ? AND status = 'closed'",
        segment.segment_date);
      deleted.push(segment.segment_date);
    }
    return Response.json({ deleted });
  }

  #events(): Response {
    const events = [...this.#sql.exec<StoredAuditRow>(
      `SELECT event_id, principal_id, event_type, outcome, request_id, occurred_at,
              metadata_json, previous_hash, event_hash
       FROM events ORDER BY occurred_at DESC, sequence DESC LIMIT 100`,
    )].map((event) => ({
      eventId: event.event_id,
      ...(event.principal_id ? { principalId: event.principal_id } : {}),
      eventType: event.event_type,
      outcome: event.outcome,
      requestId: event.request_id,
      occurredAt: event.occurred_at,
      metadata: JSON.parse(event.metadata_json) as unknown,
      ...(event.previous_hash ? { previousHash: event.previous_hash } : {}),
      eventHash: event.event_hash,
    }));
    return Response.json({ events });
  }
}

const yesterdayUtc = (): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const nextUtcDay = (): number => {
  const date = new Date();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 5);
};

export default { fetch: () => new Response("Not Found", { status: 404 }) } satisfies ExportedHandler<Bindings>;
