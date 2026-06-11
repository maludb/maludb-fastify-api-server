/**
 * Local auth-store row types. The store is a flat SQLite port of the PHP local MySQL tables:
 * one `users` row per API token (token hash + role + the tenant Postgres connection) and a
 * `model_prompts` table for the memory/ingest LLM connection.
 */

/** A token's resolved row — the tenant connection + role this request runs as. */
export interface TokenRow {
  user_id: number;
  role: string;
  pg_dbname: string;
  pg_user: string;
  pg_password: string;
}

/** Full `users` row (token listing / management — never exposes the token or password). */
export interface UserTokenRow {
  id: number;
  token_prefix: string | null;
  user_id: number;
  role: string;
  pg_dbname: string;
  pg_user: string;
  expires_at: string | null;
  device_name: string | null;
  created_at: string;
}

/** Per-model extraction prompt + LLM connection (used by /v1/memory/ingest). */
export interface ModelPromptRow {
  model_name: string;
  model_identifier: string | null;
  api_format: string;
  system_prompt: string;
  base_url: string;
  api_key: string | null;
  max_tokens: number;
  generation_params: string | null;
}

/** A seeded `default_prompts` catalog row (full row, including the prompt text). */
export interface DefaultPromptRow {
  provider: string;
  model_name: string;
  model_identifier: string;
  api_format: string;
  base_url: string;
  task: string;
  system_prompt: string | null;
  max_tokens: number;
  generation_params: string | null;
}

/** A catalog listing row — the prompt text is replaced by a has_system_prompt flag. */
export interface DefaultPromptListRow {
  provider: string;
  model_name: string;
  model_identifier: string;
  api_format: string;
  base_url: string;
  task: string;
  max_tokens: number;
  has_system_prompt: boolean;
}

/** A user's stored provider key (includes the key value — internal use only, never serialized). */
export interface UserProviderKeyRow {
  provider: string;
  api_key: string | null;
  base_url: string | null;
}

/** A provider listing row — the key value is never selected, only the key_set flag. */
export interface UserProviderKeyListRow {
  provider: string;
  key_set: boolean;
  base_url: string | null;
  updated_at: string;
}

/** The user's stored model choice for one task. */
export interface UserModelChoiceRow {
  task: string;
  model_name: string;
  system_prompt: string | null;
}

/** A model-choice listing row — the prompt override is reported only as a flag. */
export interface UserModelChoiceListRow {
  task: string;
  model_name: string;
  system_prompt_override: boolean;
  updated_at: string;
}
