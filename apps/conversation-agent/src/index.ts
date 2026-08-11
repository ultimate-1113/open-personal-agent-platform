import { informationPolicySchema } from "@opap/contracts";

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
};

type CreateMemoryInput = {
  principalId: string;
  idempotencyKey: string;
  key: string;
  value: string;
};

type AppendExchangeInput = {
  principalId: string;
  idempotencyKey: string;
  userContent: string;
  assistantContent: string;
  providerId: string;
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
    input["title"].length > 0 && input["title"].length <= 500;
};

const isCreateMemoryInput = (value: unknown): value is CreateMemoryInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input["principalId"] === "string" &&
    typeof input["idempotencyKey"] === "string" &&
    typeof input["key"] === "string" && input["key"].length > 0 && input["key"].length <= 200 &&
    typeof input["value"] === "string" && input["value"].length <= 32_768;
};

const isAppendExchangeInput = (value: unknown): value is AppendExchangeInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return ["principalId", "idempotencyKey", "userContent", "assistantContent", "providerId"].every(
    (key) => typeof input[key] === "string",
  ) && String(input["userContent"]).length <= 32_768 &&
    String(input["assistantContent"]).length <= 65_536;
};

export class ConversationAgent {
  readonly #sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.#sql = state.storage.sql;
    this.#sql.exec(`
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
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/initialize") {
      const value: unknown = await request.json().catch(() => null);
      if (!isInitializeInput(value)) {
        return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
      }
      return this.#initialize(value);
    }
    if (request.method === "GET" && path === "/state") return this.#state();
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
    if (request.method === "GET" && path === "/tasks") return this.#tasks();
    if (request.method === "POST" && path === "/tasks") {
      const value: unknown = await request.json().catch(() => null);
      return isCreateTaskInput(value)
        ? this.#createTask(value)
        : Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (request.method === "GET" && path === "/memories") return this.#memories();
    if (request.method === "POST" && path === "/memories") {
      const value: unknown = await request.json().catch(() => null);
      return isCreateMemoryInput(value)
        ? this.#upsertMemory(value)
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
       FROM messages ORDER BY created_at, message_id LIMIT 100`,
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

  #createTask(input: CreateTaskInput): Response {
    const replay = this.#replay(`task:${input.idempotencyKey}`);
    if (replay) return Response.json(replay);
    const now = new Date().toISOString();
    const task = {
      taskId: `task:${crypto.randomUUID()}`,
      title: input.title,
      status: "pending",
      callCounts: {},
      createdAt: now,
      updatedAt: now,
    };
    this.#sql.exec(
      `INSERT INTO tasks
       (task_id, title, status, call_counts_json, policy_snapshot_json, created_at, updated_at)
       VALUES (?, ?, 'pending', '{}', '{}', ?, ?)`,
      task.taskId,
      task.title,
      now,
      now,
    );
    this.#recordWrite(`task:${input.idempotencyKey}`, task, {
      eventType: "task.created",
      outcome: "success",
      principalId: input.principalId,
      taskId: task.taskId,
    }, now);
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

  #tasks(): Response {
    const tasks = [...this.#sql.exec<{
      task_id: string;
      title: string;
      status: string;
      call_counts_json: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT task_id, title, status, call_counts_json, created_at, updated_at
       FROM tasks ORDER BY created_at DESC LIMIT 100`,
    )].map((task) => ({
      taskId: task.task_id,
      title: task.title,
      status: task.status,
      callCounts: JSON.parse(task.call_counts_json) as unknown,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    }));
    return Response.json({ tasks });
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
