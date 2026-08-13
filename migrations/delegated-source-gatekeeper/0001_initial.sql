PRAGMA foreign_keys = ON;

CREATE TABLE source_oauth_transactions (
  deployment_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('google', 'github')),
  state_digest TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  resource_allowlist_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, transaction_id),
  UNIQUE (deployment_id, state_digest)
);

CREATE TABLE source_connections (
  deployment_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('google', 'github')),
  external_subject_hash TEXT NOT NULL,
  account_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  resource_allowlist_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, connection_id),
  UNIQUE (deployment_id, provider_id, external_subject_hash)
);

CREATE TABLE source_encrypted_credentials (
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
    REFERENCES source_connections(deployment_id, connection_id)
);

CREATE INDEX source_connections_provider_status
  ON source_connections(deployment_id, provider_id, status);
