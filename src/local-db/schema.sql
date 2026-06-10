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

-- Seeded catalog of default model configurations, one row per (model, task).
-- Seeded at startup by src/local-db/llm-catalog.ts (INSERT OR IGNORE — re-seeding never
-- overwrites a row an operator hand-edited). No api_key here: users attach their own
-- provider keys in user_provider_keys.
CREATE TABLE IF NOT EXISTS default_prompts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT    NOT NULL,                  -- 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'ollama'
  model_name        TEXT    NOT NULL,                  -- lookup key (the `model` request value / choice value)
  model_identifier  TEXT    NOT NULL,                  -- actual API model id (e.g. 'gpt-4o')
  api_format        TEXT    NOT NULL DEFAULT 'openai', -- 'openai' | 'anthropic'
  base_url          TEXT    NOT NULL,
  task              TEXT    NOT NULL,                  -- 'extract' | 'skill_extract' | 'embed' (free string)
  system_prompt     TEXT,                              -- NULL for 'embed' rows
  max_tokens        INTEGER NOT NULL DEFAULT 2048,
  generation_params TEXT,                              -- JSON merged into the request body
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (model_name, task)
);

-- One LLM provider API key per user. Config is keyed by user_id (not token): a user may hold
-- several tokens that all share the same provider keys.
CREATE TABLE IF NOT EXISTS user_provider_keys (
  user_id    INTEGER NOT NULL,
  provider   TEXT    NOT NULL,
  api_key    TEXT    NOT NULL,
  base_url   TEXT,                                     -- optional per-user override (e.g. self-hosted ollama)
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, provider)
);

-- The user's model choice per task, with an optional system-prompt override.
CREATE TABLE IF NOT EXISTS user_model_choices (
  user_id       INTEGER NOT NULL,
  task          TEXT    NOT NULL,
  model_name    TEXT    NOT NULL,                      -- must exist in default_prompts for this task
  system_prompt TEXT,                                  -- NULL = use the catalog prompt
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, task)
);
