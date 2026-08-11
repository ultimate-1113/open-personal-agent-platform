CREATE TABLE oauth_transactions (
  deployment_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('google', 'github', 'discord')),
  connection_kind TEXT NOT NULL CHECK (connection_kind IN ('personal', 'delegated-source')),
  state_digest TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, transaction_id)
);

CREATE UNIQUE INDEX oauth_transactions_state
  ON oauth_transactions(deployment_id, state_digest);

CREATE INDEX oauth_transactions_expiry
  ON oauth_transactions(deployment_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE credential_rotation_events (
  deployment_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  rotation_id TEXT NOT NULL,
  previous_key_id TEXT NOT NULL,
  next_key_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, rotation_id),
  FOREIGN KEY (deployment_id, connection_id)
    REFERENCES connections(deployment_id, connection_id)
);
