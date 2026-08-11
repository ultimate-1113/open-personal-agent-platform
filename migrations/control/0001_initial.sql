PRAGMA foreign_keys = ON;

CREATE TABLE deployments (
  deployment_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  owner_bootstrapped_at TEXT
);

CREATE TABLE principals (
  deployment_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'delegated', 'service', 'agent', 'anonymous')),
  issuer TEXT,
  subject_hash TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  PRIMARY KEY (deployment_id, principal_id),
  FOREIGN KEY (deployment_id) REFERENCES deployments(deployment_id)
);

CREATE UNIQUE INDEX principals_identity
  ON principals(deployment_id, issuer, subject_hash)
  WHERE issuer IS NOT NULL AND subject_hash IS NOT NULL;

CREATE UNIQUE INDEX principals_single_owner
  ON principals(deployment_id)
  WHERE kind = 'owner';

CREATE TABLE capability_grants (
  deployment_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  resource_ids_json TEXT NOT NULL,
  destination_ids_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, grant_id),
  FOREIGN KEY (deployment_id, principal_id)
    REFERENCES principals(deployment_id, principal_id)
);

CREATE TABLE policy_versions (
  deployment_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, policy_id, version)
);

CREATE TABLE approvals (
  deployment_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision_idempotency_key TEXT,
  PRIMARY KEY (deployment_id, approval_id)
);

CREATE INDEX approvals_pending
  ON approvals(deployment_id, status, expires_at);

-- High-volume observations and audit events live in SQLite-backed Durable
-- Objects. D1 stores only periodic checkpoints used to verify exported chains.
CREATE TABLE audit_checkpoints (
  deployment_id TEXT NOT NULL,
  checkpoint_date TEXT NOT NULL,
  last_event_id TEXT NOT NULL,
  last_event_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  r2_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, checkpoint_date)
);

CREATE TABLE delegated_sources (
  deployment_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  resource_ids_json TEXT NOT NULL,
  acl_json TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, source_id)
);

CREATE TABLE platform_api_tokens (
  deployment_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  argon2id_hash TEXT NOT NULL,
  capability_ids_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, token_id)
);

CREATE TABLE plugin_installations (
  deployment_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  granted_capability_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, installation_id)
);

CREATE TABLE provider_settings (
  deployment_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  allowed_information_json TEXT NOT NULL,
  soft_budget_micros INTEGER,
  hard_budget_micros INTEGER,
  last_idempotency_key TEXT,
  last_update_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, provider_id)
);

CREATE TABLE cloud_cost_policies (
  deployment_id TEXT PRIMARY KEY,
  non_ai_mode TEXT NOT NULL CHECK (non_ai_mode IN ('included-fraction', 'unlimited')),
  non_ai_fraction REAL CHECK (
    (non_ai_mode = 'unlimited' AND non_ai_fraction IS NULL) OR
    (non_ai_mode = 'included-fraction' AND non_ai_fraction BETWEEN 0.1 AND 1.0)
  ),
  ai_monthly_overage_micros INTEGER,
  pricing_catalog_version TEXT NOT NULL,
  last_idempotency_key TEXT,
  last_update_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES deployments(deployment_id)
);
