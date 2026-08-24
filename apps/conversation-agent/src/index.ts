import { informationPolicySchema } from "@opap/contracts";
import { isTaskSchedule, nextTaskRunAt, type TaskSchedule } from "./schedule.js";

type TaskRunnerRpc = {
  runScheduledTask(input: {
    conversationId: string;
    principalId: string;
    taskId: string;
    title: string;
    description: string;
    scheduledFor: string;
  }): Promise<{ ok: boolean; errorCode?: string }>;
};

type Bindings = { TASK_RUNNER?: TaskRunnerRpc };

type InitializeInput = {
  conversationId: string;
  principalId: string;
  idempotencyKey: string;
  content?: string;
};

type ConversationRow = {
  conversation_id: string;
  principal_id: string;
  created_at: string;
  updated_at: string;
};

const firstRow = <T>(rows: Iterable<T>): T | undefined => {
  for (const row of rows) return row;
  return undefined;
};

type CreateTaskInput = {
  principalId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  schedule: Exclude<TaskSchedule, { kind: "none" }>;
  enabled?: boolean;
};

type CreateMemoryInput = {
  principalId: string;
  idempotencyKey: string;
  key: string;
  value: string;
};

type UpdateTaskInput = {
  principalId: string;
  idempotencyKey: string;
  taskId: string;
  title?: string;
  description?: string;
  status?: "pending" | "in-progress" | "completed";
  schedule?: TaskSchedule;
  enabled?: boolean;
};

type DeleteResourceInput = {
  principalId: string;
  idempotencyKey: string;
  resourceId: string;
};

type AppendExchangeInput = {
  principalId: string;
  idempotencyKey: string;
  userContent: string;
  assistantContent: string;
  providerId: string;
};

type PendingConnectorResultInput = {
  principalId: string;
  resultId: string;
  question: string;
  result: string;
  display: string;
};

type AppendAssistantInput = {
  principalId: string;
  idempotencyKey: string;
  content: string;
  providerId: string;
  sensitivity?: "normal" | "sensitive";
};

const isInitializeInput = (value: unknown): value is InitializeInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["conversationId"] === "string" &&
    typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    (input["content"] === undefined ||
      (typeof input["content"] === "string" && input["content"].length <= 32_768));
};

const isCreateTaskInput = (value: unknown): value is CreateTaskInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    typeof input["title"] === "string" &&
    input["title"].length > 0 && input["title"].length <= 500 &&
    typeof input["description"] === "string" && input["description"].length > 0 &&
    input["description"].length <= 32_768 &&
    isTaskSchedule(input["schedule"]) && input["schedule"].kind !== "none" &&
    (input["enabled"] === undefined || input["enabled"] === true);
};

const isCreateMemoryInput = (value: unknown): value is CreateMemoryInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    typeof input["key"] === "string" && input["key"].length > 0 && input["key"].length <= 200 &&
    typeof input["value"] === "string" && input["value"].length <= 32_768;
};

const isUpdateTaskInput = (value: unknown): value is UpdateTaskInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    typeof input["taskId"] === "string" && /^task:[0-9a-f-]{36}$/u.test(input["taskId"]) &&
    (input["title"] === undefined || (typeof input["title"] === "string" &&
      input["title"].length > 0 && input["title"].length <= 500)) &&
    (input["description"] === undefined || (typeof input["description"] === "string" &&
      input["description"].length > 0 && input["description"].length <= 32_768)) &&
    (input["status"] === undefined || input["status"] === "pending" ||
      input["status"] === "in-progress" || input["status"] === "completed") &&
    (input["schedule"] === undefined || isTaskSchedule(input["schedule"])) &&
    (input["enabled"] === undefined || typeof input["enabled"] === "boolean") &&
    ["title", "description", "status", "schedule", "enabled"].some((key) => input[key] !== undefined);
};

const isDeleteResourceInput = (value: unknown): value is DeleteResourceInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    typeof input["resourceId"] === "string";
};

const isAppendExchangeInput = (value: unknown): value is AppendExchangeInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["principalId", "idempotencyKey", "userContent", "assistantContent", "providerId"].every(
    (key) => typeof input[key] === "string",
  ) && String(input["userContent"]).length <= 32_768 &&
    String(input["assistantContent"]).length <= 65_536;
};

const isPendingConnectorResultInput = (value: unknown): value is PendingConnectorResultInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["resultId"] === "string" && /^connector-result:[0-9a-f-]{36}$/u.test(input["resultId"]) &&
    typeof input["question"] === "string" && input["question"].length <= 32_768 &&
    typeof input["result"] === "string" && input["result"].length <= 65_536 &&
    typeof input["display"] === "string" && input["display"].length <= 65_536;
};

const isAppendAssistantInput = (value: unknown): value is AppendAssistantInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" && typeof input["idempotencyKey"] === "string" &&
    typeof input["content"] === "string" && input["content"].length <= 65_536 &&
    typeof input["providerId"] === "string" &&
    (input["sensitivity"] === undefined || input["sensitivity"] === "normal" ||
      input["sensitivity"] === "sensitive");
};

export class ConversationAgent {
  readonly #sql: SqlStorage;
  readonly #durableState: DurableObjectState;
  readonly #env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.#durableState = state;
    this.#env = env;
    this.#sql = state.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation (
        conversation_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        information_policy_json TEXT NOT NULL,
        observation_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        idempotency_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        call_counts_json TEXT NOT NULL,
        policy_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS structured_memory (
        memory_key TEXT PRIMARY KEY,
        memory_value TEXT NOT NULL,
        information_policy_json TEXT NOT NULL,
        observation_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_connector_results (
        result_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        question TEXT NOT NULL,
        result TEXT NOT NULL,
        display TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    const schema = firstRow(this.#sql.exec<{ schema_version: number }>(
      "SELECT schema_version FROM schema_metadata WHERE singleton = 1",
    ));
    const taskColumns = [...this.#sql.exec<{ name: string }>("PRAGMA table_info(tasks)")];
    if (!taskColumns.some((column) => column.name === "description")) {
      this.#sql.exec("ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
    const additions = [
      ["schedule_json", "TEXT NOT NULL DEFAULT '{\"kind\":\"none\"}'"],
      ["enabled", "INTEGER NOT NULL DEFAULT 1"],
      ["next_run_at", "TEXT"],
      ["last_run_at", "TEXT"],
      ["last_run_status", "TEXT"],
      ["last_error_code", "TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!taskColumns.some((column) => column.name === name)) {
        this.#sql.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      }
    }
    if (!schema || schema.schema_version < 2) {
      this.#sql.exec(
        `INSERT INTO schema_metadata (singleton, schema_version, updated_at) VALUES (1, 2, ?)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = 2, updated_at = excluded.updated_at`,
        new Date().toISOString(),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ((request.method === "POST" || request.method === "PATCH") &&
      this.#sql.databaseSize >= 500 * 1024 * 1024) {
      return Response.json({ code: "STORAGE_BUDGET_REACHED" }, { status: 507 });
    }
    if (request.method === "POST" && path === "/initialize") {
      const value: unknown = await request.json().catch(() => null);
      if (!isInitializeInput(value)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      return this.#initialize(value);
    }
    if (request.method === "GET" && path === "/state") return this.#state();
    if (request.method === "GET" && path === "/metadata") return this.#metadata();
    if (request.method === "DELETE" && path === "/delete") {
      return this.#durableState.blockConcurrencyWhile(() => this.#deleteConversation());
    }
    if (request.method === "GET" && path === "/exchange/replay") {
      const idempotencyKey = new URL(request.url).searchParams.get("idempotencyKey");
      if (!idempotencyKey) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      const replay = this.#replay(`exchange:${idempotencyKey}`);
      return replay
        ? Response.json(replay)
        : Response.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    if (request.method === "POST" && path === "/exchange") {
      const value: unknown = await request.json().catch(() => null);
      return isAppendExchangeInput(value)
        ? this.#appendExchange(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "POST" && path === "/connector-results") {
      const value: unknown = await request.json().catch(() => null);
      return isPendingConnectorResultInput(value)
        ? this.#storeConnectorResult(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "POST" && path === "/connector-results/consume") {
      const value: unknown = await request.json().catch(() => null);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      const input = value as Record<string, unknown>;
      return typeof input["principalId"] === "string" && typeof input["resultId"] === "string"
        ? this.#consumeConnectorResult(input["principalId"], input["resultId"])
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "POST" && path === "/connector-results/read") {
      const value: unknown = await request.json().catch(() => null);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      const input = value as Record<string, unknown>;
      return typeof input["principalId"] === "string" && typeof input["resultId"] === "string"
        ? this.#readConnectorResult(input["principalId"], input["resultId"])
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "POST" && path === "/messages/assistant") {
      const value: unknown = await request.json().catch(() => null);
      return isAppendAssistantInput(value)
        ? this.#appendAssistant(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "GET" && path === "/tasks") return this.#tasks();
    if (request.method === "POST" && path === "/tasks") {
      const value: unknown = await request.json().catch(() => null);
      return isCreateTaskInput(value)
        ? await this.#createTask(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "PATCH" && path.startsWith("/tasks/")) {
      const value: unknown = await request.json().catch(() => null);
      return isUpdateTaskInput(value)
        ? await this.#updateTask(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "DELETE" && path.startsWith("/tasks/")) {
      const value: unknown = await request.json().catch(() => null);
      return isDeleteResourceInput(value)
        ? await this.#deleteTask(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "GET" && path === "/memories") return this.#memories();
    if (request.method === "POST" && path === "/memories") {
      const value: unknown = await request.json().catch(() => null);
      return isCreateMemoryInput(value)
        ? this.#upsertMemory(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "DELETE" && path.startsWith("/memories/")) {
      const value: unknown = await request.json().catch(() => null);
      return isDeleteResourceInput(value)
        ? this.#deleteMemory(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    return new Response("Not Found", { status: 404 });
  }

  #initialize(input: InitializeInput): Response {
    if (this.#sql.databaseSize >= 500 * 1024 * 1024) {
      return Response.json({ code: "STORAGE_BUDGET_REACHED" }, { status: 507 });
    }
    const replay = firstRow(this.#sql.exec<{ response_json: string }>(
      `SELECT response_json FROM idempotency WHERE idempotency_key = ?`,
      input.idempotencyKey,
    ));
    if (replay) {
      return Response.json(JSON.parse(replay.response_json) as unknown);
    }
    const existing = firstRow(this.#sql.exec<ConversationRow>(
      `SELECT conversation_id, principal_id, created_at, updated_at FROM conversation LIMIT 1`,
    ));
    if (existing && (
      existing.conversation_id !== input.conversationId ||
      existing.principal_id !== input.principalId
    )) {
      return Response.json({ code: "CONVERSATION_IDENTITY_CONFLICT" }, { status: 409 });
    }
    const now = new Date().toISOString();
    this.#sql.exec(
      `INSERT OR IGNORE INTO conversation
       (conversation_id, principal_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      input.conversationId,
      input.principalId,
      now,
      now,
    );
    if (input.content !== undefined) {
      const policy = informationPolicySchema.parse({
        subjectPrincipalIds: [input.principalId],
        visibility: "owner",
        sensitivity: "normal",
        trust: "trusted",
        allowedAudienceIds: [input.principalId],
        allowedDestinationIds: [],
        retention: { mode: "until-deleted" },
      });
      this.#sql.exec(
        `INSERT INTO messages
         (message_id, role, content, information_policy_json, observation_ids_json, created_at)
         VALUES (?, 'user', ?, ?, '[]', ?)`,
        `message:${crypto.randomUUID()}`,
        input.content,
        JSON.stringify(policy),
        now,
      );
    }
    const response = { conversationId: input.conversationId, createdAt: existing?.created_at ?? now };
    this.#sql.exec(
      `INSERT INTO audit_outbox (event_json, created_at) VALUES (?, ?)`,
      JSON.stringify({
        eventType: "conversation.updated",
        outcome: "success",
        principalId: input.principalId,
        conversationId: input.conversationId,
      }),
      now,
    );
    this.#sql.exec(
      `INSERT INTO idempotency (idempotency_key, response_json, created_at) VALUES (?, ?, ?)`,
      input.idempotencyKey,
      JSON.stringify(response),
      now,
    );
    return Response.json(response);
  }

  #metadata(): Response {
    const conversation = firstRow(this.#sql.exec<ConversationRow>(
      `SELECT conversation_id, principal_id, created_at, updated_at FROM conversation LIMIT 1`,
    ));
    return conversation
      ? Response.json({
          conversationId: conversation.conversation_id,
          principalId: conversation.principal_id,
          createdAt: conversation.created_at,
          updatedAt: conversation.updated_at,
          databaseSizeBytes: this.#sql.databaseSize,
          schemaVersion: 2,
        })
      : Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  async #deleteConversation(): Promise<Response> {
    const conversation = firstRow(this.#sql.exec<ConversationRow>(
      `SELECT conversation_id, principal_id, created_at, updated_at FROM conversation LIMIT 1`,
    ));
    if (!conversation) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    await this.#durableState.storage.deleteAll();
    return Response.json({ conversationId: conversation.conversation_id, deleted: true });
  }

  #state(): Response {
    const conversation = firstRow(this.#sql.exec<ConversationRow>(
      `SELECT conversation_id, principal_id, created_at, updated_at FROM conversation LIMIT 1`,
    ));
    if (!conversation) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const messages = [...this.#sql.exec<{
      message_id: string;
      role: string;
      content: string;
      information_policy_json: string;
      observation_ids_json: string;
      created_at: string;
    }>(
      `SELECT message_id, role, content, information_policy_json,
              observation_ids_json, created_at
       FROM messages
       WHERE rowid IN (SELECT rowid FROM messages ORDER BY rowid DESC LIMIT 100)
       ORDER BY rowid`,
    )].map((message) => ({
      messageId: message.message_id,
      role: message.role,
      content: message.content,
      informationPolicy: JSON.parse(message.information_policy_json) as unknown,
      observationIds: JSON.parse(message.observation_ids_json) as unknown,
      createdAt: message.created_at,
    }));
    return Response.json({
      conversationId: conversation.conversation_id,
      principalId: conversation.principal_id,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      messages,
    });
  }

  async #createTask(input: CreateTaskInput): Promise<Response> {
    const replay = this.#replay(`task:${input.idempotencyKey}`);
    if (replay) return Response.json(replay);
    const now = new Date().toISOString();
    const schedule = input.schedule ?? { kind: "none" };
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? nextTaskRunAt(schedule, new Date()) : undefined;
    if (enabled && !nextRunAt) {
      return Response.json({ code: "TASK_SCHEDULE_HAS_NO_FUTURE_RUN" }, { status: 400 });
    }
    const task = {
      taskId: `task:${crypto.randomUUID()}`,
      title: input.title,
      description: input.description,
      status: "pending",
      schedule,
      enabled,
      nextRunAt: nextRunAt ?? null,
      lastRunAt: null,
      lastRunStatus: null,
      lastErrorCode: null,
      callCounts: {},
      createdAt: now,
      updatedAt: now,
    };
    this.#sql.exec(
      `INSERT INTO tasks
       (task_id, title, description, status, call_counts_json, policy_snapshot_json,
        schedule_json, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', '{}', '{}', ?, ?, ?, ?, ?)`,
      task.taskId,
      task.title,
      task.description,
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      nextRunAt ?? null,
      now,
      now,
    );
    this.#recordWrite(`task:${input.idempotencyKey}`, task, {
      eventType: "task.created",
      outcome: "success",
      principalId: input.principalId,
      taskId: task.taskId,
    }, now);
    await this.#rescheduleAlarm();
    return Response.json(task, { status: 201 });
  }

  #appendExchange(input: AppendExchangeInput): Response {
    const key = `exchange:${input.idempotencyKey}`;
    const replay = this.#replay(key);
    if (replay) return Response.json(replay);
    const now = new Date().toISOString();
    const policy = informationPolicySchema.parse({
      subjectPrincipalIds: [input.principalId],
      visibility: "owner",
      sensitivity: "normal",
      trust: "trusted",
      allowedAudienceIds: [input.principalId],
      allowedDestinationIds: [input.providerId],
      retention: { mode: "until-deleted" },
    });
    const userMessageId = `message:${crypto.randomUUID()}`;
    const assistantMessageId = `message:${crypto.randomUUID()}`;
    this.#sql.exec(
      `INSERT INTO messages
       (message_id, role, content, information_policy_json, observation_ids_json, created_at)
       VALUES (?, 'user', ?, ?, '[]', ?), (?, 'assistant', ?, ?, '[]', ?)`,
      userMessageId, input.userContent, JSON.stringify(policy), now,
      assistantMessageId, input.assistantContent, JSON.stringify(policy), now,
    );
    this.#sql.exec(`UPDATE conversation SET updated_at = ?`, now);
    const response = {
      user: { messageId: userMessageId, role: "user", content: input.userContent, createdAt: now },
      assistant: {
        messageId: assistantMessageId,
        role: "assistant",
        content: input.assistantContent,
        providerId: input.providerId,
        createdAt: now,
      },
    };
    this.#recordWrite(key, response, {
      eventType: "conversation.message.created",
      outcome: "success",
      principalId: input.principalId,
      providerId: input.providerId,
    }, now);
    return Response.json(response, { status: 201 });
  }

  #storeConnectorResult(input: PendingConnectorResultInput): Response {
    const now = new Date();
    this.#sql.exec("DELETE FROM pending_connector_results WHERE expires_at <= ?", now.toISOString());
    this.#sql.exec(
      `INSERT OR REPLACE INTO pending_connector_results
       (result_id, principal_id, question, result, display, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.resultId, input.principalId, input.question, input.result, input.display, now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    );
    return Response.json({ resultId: input.resultId }, { status: 201 });
  }

  #consumeConnectorResult(principalId: string, resultId: string): Response {
    const response = this.#readConnectorResult(principalId, resultId);
    if (!response.ok) return response;
    this.#sql.exec("DELETE FROM pending_connector_results WHERE result_id = ?", resultId);
    return response;
  }

  #readConnectorResult(principalId: string, resultId: string): Response {
    const row = firstRow(this.#sql.exec<{
      question: string; result: string; display: string; expires_at: string;
    }>(`SELECT question, result, display, expires_at FROM pending_connector_results
        WHERE result_id = ? AND principal_id = ?`, resultId, principalId));
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      this.#sql.exec("DELETE FROM pending_connector_results WHERE result_id = ?", resultId);
      return Response.json({ code: "CONNECTOR_RESULT_EXPIRED" }, { status: 410 });
    }
    return Response.json({ question: row.question, result: row.result, display: row.display });
  }

  #appendAssistant(input: AppendAssistantInput): Response {
    const key = `assistant:${input.idempotencyKey}`;
    const replay = this.#replay(key);
    if (replay) return Response.json(replay);
    const now = new Date().toISOString();
    const policy = informationPolicySchema.parse({
      subjectPrincipalIds: [input.principalId], visibility: "owner",
      sensitivity: input.sensitivity ?? "sensitive",
      trust: "external", allowedAudienceIds: [input.principalId],
      allowedDestinationIds: [input.providerId], retention: { mode: "until-deleted" },
    });
    const messageId = `message:${crypto.randomUUID()}`;
    this.#sql.exec(
      `INSERT INTO messages
       (message_id, role, content, information_policy_json, observation_ids_json, created_at)
       VALUES (?, 'assistant', ?, ?, '[]', ?)`,
      messageId, input.content, JSON.stringify(policy), now,
    );
    this.#sql.exec("UPDATE conversation SET updated_at = ?", now);
    const response = { messageId, role: "assistant", content: input.content,
      providerId: input.providerId, createdAt: now };
    this.#recordWrite(key, response, { eventType: "conversation.message.created", outcome: "success",
      principalId: input.principalId, providerId: input.providerId }, now);
    return Response.json(response, { status: 201 });
  }

  #tasks(): Response {
    const tasks = [...this.#sql.exec<{
      task_id: string;
      title: string;
      description: string;
      status: string;
      call_counts_json: string;
      schedule_json: string;
      enabled: number;
      next_run_at: string | null;
      last_run_at: string | null;
      last_run_status: string | null;
      last_error_code: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT task_id, title, description, status, call_counts_json, schedule_json, enabled,
              next_run_at, last_run_at, last_run_status, last_error_code, created_at, updated_at
       FROM tasks ORDER BY created_at DESC LIMIT 100`,
    )].map((task) => ({
      taskId: task.task_id,
      title: task.title,
      description: task.description,
      status: task.status,
      callCounts: JSON.parse(task.call_counts_json) as unknown,
      schedule: JSON.parse(task.schedule_json) as unknown,
      enabled: task.enabled === 1,
      nextRunAt: task.next_run_at,
      lastRunAt: task.last_run_at,
      lastRunStatus: task.last_run_status,
      lastErrorCode: task.last_error_code,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    }));
    return Response.json({ tasks });
  }

  async #updateTask(input: UpdateTaskInput): Promise<Response> {
    const key = `task-update:${input.idempotencyKey}`;
    const replay = this.#replay(key);
    if (replay) return Response.json(replay);
    const existing = firstRow(this.#sql.exec<{
      title: string; description: string; status: "pending" | "in-progress" | "completed";
      created_at: string; schedule_json: string; enabled: number;
      last_run_at: string | null; last_run_status: string | null; last_error_code: string | null;
    }>(
      `SELECT title, description, status, created_at, schedule_json, enabled,
        last_run_at, last_run_status, last_error_code
       FROM tasks WHERE task_id = ?`, input.taskId,
    ));
    if (!existing) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const now = new Date().toISOString();
    const schedule = input.schedule ?? JSON.parse(existing.schedule_json) as TaskSchedule;
    const enabled = input.enabled ?? existing.enabled === 1;
    const status = input.status ?? existing.status;
    const nextRunAt = enabled && status !== "completed"
      ? nextTaskRunAt(schedule, new Date()) : undefined;
    if (schedule.kind !== "none" && enabled && status !== "completed" && !nextRunAt) {
      return Response.json({ code: "TASK_SCHEDULE_HAS_NO_FUTURE_RUN" }, { status: 400 });
    }
    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    this.#sql.exec(
      `UPDATE tasks SET title = ?, description = ?, status = ?, schedule_json = ?, enabled = ?,
       next_run_at = ?, updated_at = ? WHERE task_id = ?`,
      title, description, status, JSON.stringify(schedule), enabled ? 1 : 0,
      nextRunAt ?? null, now, input.taskId,
    );
    const task = {
      taskId: input.taskId,
      title,
      description,
      status,
      schedule,
      enabled,
      nextRunAt: nextRunAt ?? null,
      lastRunAt: existing.last_run_at,
      lastRunStatus: existing.last_run_status,
      lastErrorCode: existing.last_error_code,
      callCounts: {},
      createdAt: existing.created_at,
      updatedAt: now,
    };
    this.#recordWrite(key, task, {
      eventType: "task.updated", outcome: "success",
      principalId: input.principalId, taskId: input.taskId,
    }, now);
    await this.#rescheduleAlarm();
    return Response.json(task);
  }

  async #deleteTask(input: DeleteResourceInput): Promise<Response> {
    const key = `task-delete:${input.idempotencyKey}`;
    const replay = this.#replay(key);
    if (replay) return Response.json(replay);
    const deleted = this.#sql.exec(`DELETE FROM tasks WHERE task_id = ?`, input.resourceId);
    if (deleted.rowsWritten === 0) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const now = new Date().toISOString();
    const response = { taskId: input.resourceId, deleted: true };
    this.#recordWrite(key, response, {
      eventType: "task.deleted", outcome: "success",
      principalId: input.principalId, taskId: input.resourceId,
    }, now);
    await this.#rescheduleAlarm();
    return Response.json(response);
  }

  #upsertMemory(input: CreateMemoryInput): Response {
    const replay = this.#replay(`memory:${input.idempotencyKey}`);
    if (replay) return Response.json(replay);
    const now = new Date().toISOString();
    const policy = informationPolicySchema.parse({
      subjectPrincipalIds: [input.principalId],
      visibility: "owner",
      sensitivity: "normal",
      trust: "trusted",
      allowedAudienceIds: [input.principalId],
      allowedDestinationIds: [],
      retention: { mode: "until-deleted" },
    });
    const existing = firstRow(this.#sql.exec<{ created_at: string }>(
      `SELECT created_at FROM structured_memory WHERE memory_key = ?`,
      input.key,
    ));
    this.#sql.exec(
      `INSERT INTO structured_memory
       (memory_key, memory_value, information_policy_json, observation_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?)
       ON CONFLICT(memory_key) DO UPDATE SET
         memory_value = excluded.memory_value,
         information_policy_json = excluded.information_policy_json,
         updated_at = excluded.updated_at`,
      input.key,
      input.value,
      JSON.stringify(policy),
      existing?.created_at ?? now,
      now,
    );
    const memory = { key: input.key, value: input.value, informationPolicy: policy, updatedAt: now };
    this.#recordWrite(`memory:${input.idempotencyKey}`, memory, {
      eventType: "memory.updated",
      outcome: "success",
      principalId: input.principalId,
      memoryKey: input.key,
    }, now);
    return Response.json(memory);
  }

  #memories(): Response {
    const memories = [...this.#sql.exec<{
      memory_key: string;
      memory_value: string;
      information_policy_json: string;
      observation_ids_json: string;
      updated_at: string;
    }>(
      `SELECT memory_key, memory_value, information_policy_json,
              observation_ids_json, updated_at
       FROM structured_memory ORDER BY memory_key LIMIT 200`,
    )].map((memory) => ({
      key: memory.memory_key,
      value: memory.memory_value,
      informationPolicy: JSON.parse(memory.information_policy_json) as unknown,
      observationIds: JSON.parse(memory.observation_ids_json) as unknown,
      updatedAt: memory.updated_at,
    }));
    return Response.json({ memories });
  }

  #deleteMemory(input: DeleteResourceInput): Response {
    const key = `memory-delete:${input.idempotencyKey}`;
    const replay = this.#replay(key);
    if (replay) return Response.json(replay);
    const deleted = this.#sql.exec(
      `DELETE FROM structured_memory WHERE memory_key = ?`, input.resourceId,
    );
    if (deleted.rowsWritten !== 1) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const now = new Date().toISOString();
    const response = { key: input.resourceId, deleted: true };
    this.#recordWrite(key, response, {
      eventType: "memory.deleted", outcome: "success",
      principalId: input.principalId, memoryKey: input.resourceId,
    }, now);
    return Response.json(response);
  }

  async alarm(): Promise<void> {
    const now = new Date();
    const conversation = firstRow(this.#sql.exec<ConversationRow>(
      "SELECT conversation_id, principal_id, created_at, updated_at FROM conversation LIMIT 1",
    ));
    if (!conversation) {
      await this.#rescheduleAlarm();
      return;
    }
    const due = [...this.#sql.exec<{
      task_id: string;
      title: string;
      description: string;
      schedule_json: string;
      next_run_at: string;
    }>(`SELECT task_id, title, description, schedule_json, next_run_at
        FROM tasks
        WHERE enabled = 1 AND status <> 'completed' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at LIMIT 20`, now.toISOString())];

    for (const task of due) {
      const schedule = JSON.parse(task.schedule_json) as TaskSchedule;
      let outcome: { ok: boolean; errorCode?: string };
      try {
        outcome = this.#env.TASK_RUNNER
          ? await this.#env.TASK_RUNNER.runScheduledTask({
              conversationId: conversation.conversation_id,
              principalId: conversation.principal_id,
              taskId: task.task_id,
              title: task.title,
              description: task.description,
              scheduledFor: task.next_run_at,
            })
          : { ok: false, errorCode: "TASK_RUNNER_UNAVAILABLE" };
      } catch {
        outcome = { ok: false, errorCode: "TASK_RUNNER_UNAVAILABLE" };
      }
      const recurring = schedule.kind === "daily" || schedule.kind === "weekly" ||
        schedule.kind === "monthly";
      const nextRunAt = recurring ? nextTaskRunAt(schedule, now) : undefined;
      const status = !recurring && outcome.ok ? "completed" : "pending";
      this.#sql.exec(
        `UPDATE tasks SET status = ?, enabled = ?, next_run_at = ?, last_run_at = ?,
         last_run_status = ?, last_error_code = ?, updated_at = ? WHERE task_id = ?`,
        status,
        recurring ? 1 : 0,
        nextRunAt ?? null,
        now.toISOString(),
        outcome.ok ? "succeeded" : "failed",
        outcome.errorCode ?? null,
        now.toISOString(),
        task.task_id,
      );
      this.#sql.exec(
        "INSERT INTO audit_outbox (event_json, created_at) VALUES (?, ?)",
        JSON.stringify({ eventType: "task.executed", outcome: outcome.ok ? "success" : "failure",
          principalId: conversation.principal_id, taskId: task.task_id,
          scheduledFor: task.next_run_at, errorCode: outcome.errorCode }),
        now.toISOString(),
      );
    }
    await this.#rescheduleAlarm();
  }

  async #rescheduleAlarm(): Promise<void> {
    const next = firstRow(this.#sql.exec<{ next_run_at: string }>(
      `SELECT next_run_at FROM tasks
       WHERE enabled = 1 AND status <> 'completed' AND next_run_at IS NOT NULL
       ORDER BY next_run_at LIMIT 1`,
    ));
    if (next) {
      await this.#durableState.storage.setAlarm(Math.max(Date.now(), Date.parse(next.next_run_at)));
    } else {
      await this.#durableState.storage.deleteAlarm();
    }
  }

  #replay(idempotencyKey: string): Readonly<Record<string, unknown>> | undefined {
    const row = firstRow(this.#sql.exec<{ response_json: string }>(
      `SELECT response_json FROM idempotency WHERE idempotency_key = ?`,
      idempotencyKey,
    ));
    if (!row) return undefined;
    const value: unknown = JSON.parse(row.response_json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined;
  }

  #recordWrite(
    idempotencyKey: string,
    response: unknown,
    audit: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    this.#sql.exec(
      `INSERT INTO audit_outbox (event_json, created_at) VALUES (?, ?)`,
      JSON.stringify(audit),
      now,
    );
    this.#sql.exec(
      `INSERT INTO idempotency (idempotency_key, response_json, created_at) VALUES (?, ?, ?)`,
      idempotencyKey,
      JSON.stringify(response),
      now,
    );
  }
}

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
