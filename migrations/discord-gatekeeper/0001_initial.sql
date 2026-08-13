CREATE TABLE discord_destinations (
  deployment_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'guild-channel')),
  discord_user_id TEXT,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  display_policy TEXT NOT NULL CHECK (display_policy IN ('metadata-only', 'full-preview')),
  command_policy TEXT NOT NULL CHECK (command_policy IN ('approved-only', 'owner-any', 'dm-only')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (deployment_id, destination_id)
);

CREATE UNIQUE INDEX discord_active_dm_destination
  ON discord_destinations (deployment_id, discord_user_id)
  WHERE kind = 'dm' AND status = 'active';

CREATE UNIQUE INDEX discord_active_channel_destination
  ON discord_destinations (deployment_id, guild_id, channel_id)
  WHERE kind = 'guild-channel' AND status = 'active';

CREATE TABLE discord_command_manifests (
  deployment_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE discord_execution_nonces (
  deployment_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, nonce)
);

CREATE TABLE discord_notification_outbox (
  deployment_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deployment_id, outbox_id)
);

CREATE INDEX discord_notification_outbox_due
  ON discord_notification_outbox (deployment_id, status, not_before);
