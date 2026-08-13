CREATE TABLE discord_link_codes (
  deployment_id TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, code_digest)
);

CREATE INDEX discord_link_codes_expiry
  ON discord_link_codes (deployment_id, expires_at);

CREATE TABLE discord_owner_links (
  deployment_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_display_name TEXT,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  dm_notifications_enabled INTEGER NOT NULL DEFAULT 1,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (deployment_id, owner_principal_id),
  UNIQUE (deployment_id, discord_user_id)
);

CREATE INDEX discord_owner_links_status
  ON discord_owner_links (deployment_id, status);
