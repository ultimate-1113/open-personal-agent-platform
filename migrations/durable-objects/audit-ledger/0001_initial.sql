CREATE TABLE IF NOT EXISTS opap_audit_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_event_id TEXT,
  last_event_hash TEXT,
  event_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO opap_audit_state(singleton, event_count) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS opap_audit_segments (
  segment_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  first_event_hash TEXT,
  last_event_hash TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_r2_key TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'active' AND checkpoint_r2_key IS NULL AND closed_at IS NULL) OR
    (status = 'closed' AND checkpoint_r2_key IS NOT NULL AND closed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS opap_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_date TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  principal_id TEXT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure', 'unknown')),
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  FOREIGN KEY (segment_date) REFERENCES opap_audit_segments(segment_date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS opap_audit_events_segment
  ON opap_audit_events(segment_date, sequence);

CREATE TRIGGER IF NOT EXISTS opap_audit_events_no_update
BEFORE UPDATE ON opap_audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS opap_audit_segments_closed_no_update
BEFORE UPDATE ON opap_audit_segments
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed audit segments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS opap_audit_segments_checkpoint_required
BEFORE DELETE ON opap_audit_segments
WHEN OLD.status != 'closed' OR OLD.checkpoint_r2_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'audit checkpoint is required before segment deletion');
END;
