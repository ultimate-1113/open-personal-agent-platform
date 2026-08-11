ALTER TABLE approvals ADD COLUMN execution_status TEXT
  CHECK (execution_status IS NULL OR execution_status IN ('pending', 'succeeded', 'failed', 'unknown'));
ALTER TABLE approvals ADD COLUMN execution_error_code TEXT;
ALTER TABLE approvals ADD COLUMN executed_at TEXT;
