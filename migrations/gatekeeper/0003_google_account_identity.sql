ALTER TABLE connections ADD COLUMN account_label TEXT;

CREATE UNIQUE INDEX active_connection_external_subject
  ON connections(deployment_id, provider_id, connection_kind, external_subject_hash)
  WHERE external_subject_hash IS NOT NULL AND status = 'active';
