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
