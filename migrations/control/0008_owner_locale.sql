ALTER TABLE owner_preferences ADD COLUMN locale TEXT NOT NULL DEFAULT 'ja'
  CHECK (locale IN ('en', 'ja'));
