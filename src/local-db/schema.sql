-- Local SQLite auth/routing store for the MaluDB API.
--
-- A faithful, flat port of the PHP local MySQL store (config/local-database.sql): one `users` row
-- per API token, carrying the user's role and the tenant Postgres connection
-- (pg_dbname / pg_user / pg_password) that requests authenticated by that token connect with.
-- The token is stored ONLY as sha256 of the part after the `malu_` prefix (matching require_auth).
-- The PostgreSQL host/port stay fixed in env; only name/user/pass are resolved here.
--
-- Idempotent: safe to run on every `migrate`. SQLite stores timestamps as ISO-8601 UTC text.

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,        -- sha256(token after `malu_`)
  token_prefix TEXT,                           -- first chars of the token, for diagnostics/listing
  user_id      INTEGER NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'executor',
  pg_dbname    TEXT    NOT NULL,
  pg_user      TEXT    NOT NULL,
  pg_password  TEXT    NOT NULL,
  expires_at   TEXT,                            -- ISO-8601 UTC, or NULL for no expiry
  device_name  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS users_token_hash_idx ON users (token_hash);
CREATE INDEX IF NOT EXISTS users_pg_conn_idx    ON users (pg_dbname, pg_user);

-- Per-model extraction prompt + LLM connection (used by /v1/memory/ingest). The system prompt may
-- differ per model; api_format selects the request shape (OpenAI chat vs Anthropic messages). The
-- prompt contains placeholders the ingest endpoint fills before sending: {{verbs}}, {{verb_types}},
-- {{subjects}}, {{subject_types}}, {{hints}}. base_url + api_key are the LLM connection.
CREATE TABLE IF NOT EXISTS model_prompts (
  model_name        TEXT    PRIMARY KEY,        -- lookup key (the `model` request value)
  model_identifier  TEXT,                        -- actual API model id (e.g. 'gpt-4o'); defaults to model_name
  api_format        TEXT    NOT NULL DEFAULT 'openai',   -- 'openai' | 'anthropic'
  system_prompt     TEXT    NOT NULL,
  base_url          TEXT    NOT NULL,
  api_key           TEXT,
  max_tokens        INTEGER NOT NULL DEFAULT 2048,
  generation_params TEXT,                        -- JSON merged into the request body
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
