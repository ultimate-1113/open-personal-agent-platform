PRAGMA foreign_keys = ON;

CREATE TABLE connections (
  deployment_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_kind TEXT NOT NULL CHECK (connection_kind IN ('personal', 'delegated-source')),
  provider_id TEXT NOT NULL,
  external_subject_hash TEXT,
  scopes_json TEXT NOT NULL,
  resource_allowlist_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, connection_id)
);

CREATE TABLE encrypted_credentials (
  deployment_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  PRIMARY KEY (deployment_id, connection_id),
  FOREIGN KEY (deployment_id, connection_id)
    REFERENCES connections(deployment_id, connection_id)
);

CREATE TABLE execution_nonces (
  deployment_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, nonce)
);

CREATE INDEX execution_nonces_expiration
  ON execution_nonces(deployment_id, expires_at);

CREATE TABLE idempotency_records (
  deployment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'succeeded', 'failed', 'unknown')),
  provider_request_id TEXT,
  result_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, idempotency_key)
);
