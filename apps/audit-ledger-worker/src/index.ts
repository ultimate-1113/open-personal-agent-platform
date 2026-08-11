import { appendAuditEvent, type AppendAuditEventInput } from "@opap/provenance";

type AppendAuditRpcInput = Omit<AppendAuditEventInput, "occurredAt"> & {
  occurredAt?: string;
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

  constructor(state: DurableObjectState) {
    this.#state = state;
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
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/append") {
      const value: unknown = await request.json().catch(() => null);
      if (!isAppendInput(value)) return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      return this.#state.blockConcurrencyWhile(() => this.#append(value));
    }
    if (request.method === "GET" && path === "/events") return this.#events();
    return new Response("Not Found", { status: 404 });
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
    const segmentDate = event.occurredAt.slice(0, 10);
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
    return Response.json({ eventId: event.eventId, eventHash: event.eventHash }, { status: 201 });
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

export default { fetch: () => new Response("Not Found", { status: 404 }) } satisfies ExportedHandler;
