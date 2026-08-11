CREATE TABLE IF NOT EXISTS opap_usage_rollups (
  deployment_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,
  resource TEXT NOT NULL,
  used REAL NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved REAL NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, scope_id, period, resource)
);

CREATE TABLE IF NOT EXISTS opap_ai_daily_usage (
  deployment_id TEXT NOT NULL,
  day TEXT NOT NULL,
  used_neurons REAL NOT NULL DEFAULT 0,
  reserved_neurons REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, day)
);

CREATE TABLE IF NOT EXISTS opap_ai_monthly_usage (
  deployment_id TEXT NOT NULL,
  month TEXT NOT NULL,
  used_micros REAL NOT NULL DEFAULT 0,
  reserved_micros REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, month)
);

CREATE TABLE IF NOT EXISTS opap_ai_reservations (
  deployment_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  neurons REAL NOT NULL,
  free_neurons REAL NOT NULL,
  overage_micros REAL NOT NULL,
  actual_neurons REAL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, reservation_id),
  UNIQUE (deployment_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS opap_usage_reservations (
  deployment_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  actual_amount REAL,
  task_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, reservation_id),
  UNIQUE (deployment_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS opap_usage_reservations_expiry
  ON opap_usage_reservations(deployment_id, status, expires_at);
