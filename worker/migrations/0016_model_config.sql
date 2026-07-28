-- Per-user BYO-model configuration, synced across devices (the reported gap:
-- model settings lived only on-device, so a second device fell back to the
-- free default provider). One row per user.
--
-- SECURITY — mirrors the oauth_tokens trust boundary (0015):
--   * Non-secret fields (provider/model_id/base_url/region/max_tokens/
--     additional_fields) are plaintext — they're just routing config.
--   * The API key is a live provider secret (Bedrock/OpenAI/Anthropic bearer).
--     It is stored ENCRYPTED AT REST (AES-256-GCM, key from the MODEL_CONFIG_ENC_KEY
--     / INTERNAL_API_KEY server secret) in api_key_enc, NOT plaintext — a stricter
--     bar than oauth_tokens (which relies on the access boundary alone).
--   * The raw key is returned ONLY over the internal-key channel (so the
--     server-side chat route can build the model). The browser/app bridge
--     exposes has_key:true/false, NEVER the key value — same as oauth_tokens
--     ("connected?" without the token).
CREATE TABLE IF NOT EXISTS model_config (
  user_id TEXT PRIMARY KEY,           -- owner (FK users)
  provider TEXT DEFAULT '',           -- 'openai'|'bedrock'|'google'|'anthropic'|... ('' = free default)
  model_id TEXT DEFAULT '',
  base_url TEXT DEFAULT '',
  region TEXT DEFAULT '',
  max_tokens INTEGER DEFAULT 0,       -- 0 = provider default
  additional_fields TEXT DEFAULT '',  -- JSON string, provider-specific request fields
  api_key_enc TEXT DEFAULT '',        -- AES-256-GCM(iv||ciphertext), base64; '' = no key
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
