-- Multi-provider BYO-model credentials ("pizza selection"), synced across
-- devices. 0016_model_config stores ONE active config per user; this table
-- stores EVERY provider the user has configured (bedrock + anthropic + openai
-- at once), so the CLI onboarding and web settings can offer a picker instead
-- of a single slot. The active row is mirrored into model_config on write so
-- the existing chat route keeps working unchanged.
--
-- SECURITY — identical posture to model_config (0016):
--   * api_key_enc is AES-256-GCM at rest (MODEL_CONFIG_ENC_KEY / INTERNAL_API_KEY).
--   * Raw keys are returned ONLY over the internal-key channel. The app bridge
--     defaults to safe reads (hasKey), with an explicit owner-session full read
--     for device sync (the stated purpose of storing keys server-side).
CREATE TABLE IF NOT EXISTS model_providers (
  user_id TEXT NOT NULL,              -- owner (FK users)
  provider TEXT NOT NULL,             -- 'bedrock'|'anthropic'|'openai'|'google'|...
  model_id TEXT DEFAULT '',
  base_url TEXT DEFAULT '',
  region TEXT DEFAULT '',
  max_tokens INTEGER DEFAULT 0,
  additional_fields TEXT DEFAULT '',  -- JSON string, provider-specific
  api_key_enc TEXT DEFAULT '',        -- AES-256-GCM(iv||ct), base64; '' = no key
  is_active INTEGER DEFAULT 0,        -- exactly one active row per user (enforced in code)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_model_providers_user ON model_providers(user_id);
