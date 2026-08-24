PRAGMA foreign_keys = ON;

CREATE TABLE conversation_registry (
  deployment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  estimated_storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (estimated_storage_bytes >= 0),
  deleted_at TEXT,
  registry_source TEXT NOT NULL DEFAULT 'runtime'
    CHECK (registry_source IN ('runtime', 'discord-backfill', 'alpha-lazy-backfill')),
  PRIMARY KEY (deployment_id, conversation_id)
);

CREATE INDEX conversation_registry_active
  ON conversation_registry(deployment_id, deleted_at, last_used_at DESC);

CREATE TABLE maintenance_jobs (
  deployment_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('export', 'conversation-delete', 'retention', 'storage-rollup')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  target_id TEXT,
  result_json TEXT,
  error_code TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (deployment_id, job_id),
  UNIQUE (deployment_id, job_type, idempotency_key)
);

CREATE INDEX maintenance_jobs_status
  ON maintenance_jobs(deployment_id, status, updated_at);

CREATE TABLE export_files (
  deployment_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, export_id, file_name)
);

CREATE TABLE plugin_artifacts (
  deployment_id TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  expanded_bytes INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  sbom_version TEXT NOT NULL CHECK (sbom_version IN ('1.5', '1.6')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, archive_sha256)
);

CREATE TABLE plugin_inspections (
  deployment_id TEXT NOT NULL,
  inspection_id TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'expired')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, inspection_id),
  FOREIGN KEY (deployment_id, archive_sha256)
    REFERENCES plugin_artifacts(deployment_id, archive_sha256)
);

CREATE TABLE plugin_versions (
  deployment_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  requested_capability_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending-approval', 'active', 'superseded', 'revoked')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  PRIMARY KEY (deployment_id, version_id),
  FOREIGN KEY (deployment_id, installation_id)
    REFERENCES plugin_installations(deployment_id, installation_id),
  FOREIGN KEY (deployment_id, archive_sha256)
    REFERENCES plugin_artifacts(deployment_id, archive_sha256)
);

CREATE INDEX plugin_versions_installation
  ON plugin_versions(deployment_id, installation_id, created_at DESC);

CREATE TABLE plugin_execution_metadata (
  deployment_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  result_digest TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  meter_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'timeout', 'unknown')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, execution_id)
);

CREATE INDEX plugin_execution_expiry
  ON plugin_execution_metadata(deployment_id, expires_at);

CREATE TABLE storage_rollups (
  deployment_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  period TEXT NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  measured_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, resource, period)
);

ALTER TABLE plugin_installations ADD COLUMN active_version_id TEXT;
ALTER TABLE plugin_installations ADD COLUMN removed_at TEXT;
ALTER TABLE plugin_installations ADD COLUMN last_idempotency_key TEXT;

CREATE UNIQUE INDEX plugin_installations_idempotency
  ON plugin_installations(deployment_id, last_idempotency_key)
  WHERE last_idempotency_key IS NOT NULL;
