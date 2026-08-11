CREATE TABLE IF NOT EXISTS opap_conversation (
  conversation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opap_messages (
  message_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  information_policy_json TEXT NOT NULL,
  observation_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opap_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opap_tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting-approval', 'completed', 'failed')),
  call_counts_json TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opap_structured_memory (
  memory_key TEXT PRIMARY KEY,
  memory_value TEXT NOT NULL,
  information_policy_json TEXT NOT NULL,
  observation_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opap_observations (
  observation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  information_policy_json TEXT NOT NULL,
  parent_observation_ids_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS opap_observations_source
  ON opap_observations(source_type, source_resource_id);

-- Ordinary audit metadata is committed with the state change and forwarded in
-- batches. Authentication failures, grants, approvals and external writes use
-- the synchronous Audit Ledger path instead.
CREATE TABLE IF NOT EXISTS opap_audit_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS opap_audit_outbox_pending
  ON opap_audit_outbox(sequence);

-- One roll-up row per resource and period replaces per-token/per-subrequest
-- usage rows. A paid operation reserves its estimate before execution.
CREATE TABLE IF NOT EXISTS opap_usage_rollups (
  deployment_id TEXT NOT NULL,
  period TEXT NOT NULL,
  resource TEXT NOT NULL,
  used INTEGER NOT NULL,
  reserved INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, period, resource)
);
