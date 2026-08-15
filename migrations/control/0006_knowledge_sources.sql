ALTER TABLE delegated_sources ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE delegated_sources ADD COLUMN information_policy_json TEXT NOT NULL
  DEFAULT '{"subjectPrincipalIds":[],"visibility":"delegated-principal","sensitivity":"normal","trust":"external","allowedAudienceIds":["delegated"],"allowedDestinationIds":[],"retention":{"mode":"none"}}';
ALTER TABLE delegated_sources ADD COLUMN cache_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (cache_enabled IN (0, 1));
ALTER TABLE delegated_sources ADD COLUMN cache_ttl_seconds INTEGER NOT NULL DEFAULT 60
  CHECK (cache_ttl_seconds BETWEEN 1 AND 60);
ALTER TABLE delegated_sources ADD COLUMN last_idempotency_key TEXT;
ALTER TABLE delegated_sources ADD COLUMN last_update_fingerprint TEXT;

CREATE INDEX delegated_sources_connection
  ON delegated_sources(deployment_id, connection_id, enabled);
