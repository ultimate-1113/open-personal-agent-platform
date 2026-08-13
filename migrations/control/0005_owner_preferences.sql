CREATE TABLE owner_preferences (
  deployment_id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL,
  last_idempotency_key TEXT,
  last_update_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES deployments(deployment_id)
);
