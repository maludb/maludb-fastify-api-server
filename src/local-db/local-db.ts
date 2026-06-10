/**
 * Local SQLite auth/routing store (brief §6) — the npm-install replacement for the PHP local MySQL
 * `LocalDatabase`. A thin, readable wrapper around `better-sqlite3`: it executes literal SQL, it
 * does not hide the schema behind an ORM. One flat `users` row per token + a `model_prompts` table.
 *
 * The token plaintext is never stored — only `sha256(token after "malu_")`. `resolveToken` is the
 * hot path on every authenticated request.
 */
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDbPath, schemaSqlPath } from '../config/paths.js';
import { seedDefaultPrompts } from './llm-catalog.js';
import type {
  DefaultPromptListRow,
  DefaultPromptRow,
  ModelPromptRow,
  TokenRow,
  UserModelChoiceListRow,
  UserModelChoiceRow,
  UserProviderKeyListRow,
  UserProviderKeyRow,
  UserTokenRow,
} from '../types/auth.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

let singleton: Database | null = null;

/** ISO-8601 UTC timestamp, matching the format `expires_at` is stored + compared in. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Open (creating if needed) the SQLite config DB and apply the schema (idempotent). Returns the
 * handle. Tightens file permissions to 0600 so the stored tenant credentials stay readable only by
 * the owner (security req §6). `path` defaults to the env-resolved config DB.
 */
export function openLocalDb(path = configDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseConstructor(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaSqlPath(moduleDir), 'utf8'));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms.
  }
  // Seed the default_prompts catalog (INSERT OR IGNORE — idempotent, never overwrites operator
  // edits). Runs on init, migrate, and every server start.
  seedDefaultPrompts(db);
  return db;
}

/** The process-wide config DB handle (opened lazily). */
export function localDb(): Database {
  if (singleton === null) singleton = openLocalDb();
  return singleton;
}

/** Close the singleton (tests / shutdown). */
export function closeLocalDb(): void {
  if (singleton !== null) {
    singleton.close();
    singleton = null;
  }
}

/** Apply the schema to `path` and close — used by the CLI `migrate`/`init`. Idempotent. */
export function applyMigrations(path = configDbPath()): void {
  openLocalDb(path).close();
}

/**
 * Resolve a presented token's sha256 hash to its tenant connection + role, or null if the token is
 * unknown or expired. The single query run on every authenticated request.
 */
export function resolveToken(tokenHash: string): TokenRow | null {
  const row = localDb()
    .prepare(
      `SELECT user_id, role, pg_dbname, pg_user, pg_password
         FROM users
        WHERE token_hash = ?
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1`,
    )
    .get(tokenHash, nowIso()) as TokenRow | undefined;
  return row ?? null;
}

/** Load a per-model extraction prompt + LLM connection, or null. */
export function modelPrompt(model: string): ModelPromptRow | null {
  const row = localDb()
    .prepare(
      `SELECT model_name, model_identifier, api_format, system_prompt, base_url, api_key,
              max_tokens, generation_params
         FROM model_prompts WHERE model_name = ? LIMIT 1`,
    )
    .get(model) as ModelPromptRow | undefined;
  return row ?? null;
}

/** Next app user_id to assign when a token-create request doesn't supply one. */
export function nextUserId(): number {
  const row = localDb()
    .prepare(`SELECT COALESCE(MAX(user_id), 0) + 1 AS n FROM users`)
    .get() as { n: number };
  return row.n;
}

export interface InsertTokenInput {
  tokenHash: string;
  tokenPrefix: string;
  userId: number;
  role: string;
  pgDbname: string;
  pgUser: string;
  pgPassword: string;
  expiresAt: string | null;
  deviceName: string | null;
}

/** Insert a new token row; returns its `id`. */
export function insertToken(input: InsertTokenInput): number {
  const info = localDb()
    .prepare(
      `INSERT INTO users
         (token_hash, token_prefix, user_id, role, pg_dbname, pg_user, pg_password, expires_at, device_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tokenHash,
      input.tokenPrefix,
      input.userId,
      input.role,
      input.pgDbname,
      input.pgUser,
      input.pgPassword,
      input.expiresAt,
      input.deviceName,
    );
  return Number(info.lastInsertRowid);
}

/** Token metadata for one Postgres connection (never the token value or password). */
export function listTokens(pgDbname: string, pgUser: string): UserTokenRow[] {
  return localDb()
    .prepare(
      `SELECT id, token_prefix, user_id, role, pg_dbname, pg_user, expires_at, device_name, created_at
         FROM users
        WHERE pg_dbname = ? AND pg_user = ?
        ORDER BY id`,
    )
    .all(pgDbname, pgUser) as UserTokenRow[];
}

/** A single token row by id (for revoke ownership checks). */
export function getToken(id: number): UserTokenRow | null {
  const row = localDb()
    .prepare(
      `SELECT id, token_prefix, user_id, role, pg_dbname, pg_user, expires_at, device_name, created_at
         FROM users WHERE id = ?`,
    )
    .get(id) as UserTokenRow | undefined;
  return row ?? null;
}

/** Delete a token row by id; returns the number of rows removed. */
export function deleteToken(id: number): number {
  return localDb().prepare(`DELETE FROM users WHERE id = ?`).run(id).changes;
}

export interface UpsertModelPromptInput {
  modelName: string;
  modelIdentifier: string | null;
  apiFormat: string;
  systemPrompt: string;
  baseUrl: string;
  apiKey: string | null;
  maxTokens: number;
  generationParams: string | null;
}

/** Insert-or-update a model prompt (keyed on model_name). Preserves a stored key when apiKey null. */
export function upsertModelPrompt(input: UpsertModelPromptInput): void {
  localDb()
    .prepare(
      `INSERT INTO model_prompts
         (model_name, model_identifier, api_format, system_prompt, base_url, api_key, max_tokens, generation_params, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(model_name) DO UPDATE SET
         model_identifier  = excluded.model_identifier,
         api_format        = excluded.api_format,
         system_prompt     = excluded.system_prompt,
         base_url          = excluded.base_url,
         api_key           = COALESCE(excluded.api_key, model_prompts.api_key),
         max_tokens        = excluded.max_tokens,
         generation_params = excluded.generation_params,
         updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(
      input.modelName,
      input.modelIdentifier,
      input.apiFormat,
      input.systemPrompt,
      input.baseUrl,
      input.apiKey,
      input.maxTokens,
      input.generationParams,
    );
}

/** List model prompts (metadata; the api_key is reported only as a set/unset flag by callers). */
export function listModelPrompts(): ModelPromptRow[] {
  return localDb()
    .prepare(
      `SELECT model_name, model_identifier, api_format, system_prompt, base_url, api_key,
              max_tokens, generation_params
         FROM model_prompts ORDER BY model_name`,
    )
    .all() as ModelPromptRow[];
}

/* ------------------- default-prompt catalog (seeded by llm-catalog.ts) ------------------- */

/** Load the catalog row for (model_name, task), or null. */
export function defaultPrompt(modelName: string, task: string): DefaultPromptRow | null {
  const row = localDb()
    .prepare(
      `SELECT provider, model_name, model_identifier, api_format, base_url,
              task, system_prompt, max_tokens, generation_params
         FROM default_prompts
        WHERE model_name = ? AND task = ?
        LIMIT 1`,
    )
    .get(modelName, task) as DefaultPromptRow | undefined;
  return row ?? null;
}

/** All catalog rows (without the prompt text — it can be large). */
export function listDefaultPrompts(): DefaultPromptListRow[] {
  const rows = localDb()
    .prepare(
      `SELECT provider, model_name, model_identifier, api_format, base_url,
              task, max_tokens,
              (system_prompt IS NOT NULL AND system_prompt <> '') AS has_system_prompt
         FROM default_prompts
        ORDER BY task, provider, model_name`,
    )
    .all() as (Omit<DefaultPromptListRow, 'has_system_prompt'> & { has_system_prompt: number })[];
  return rows.map((r) => ({ ...r, has_system_prompt: Boolean(r.has_system_prompt) }));
}

/** Distinct providers present in the catalog. */
export function catalogProviders(): string[] {
  const rows = localDb()
    .prepare(`SELECT DISTINCT provider FROM default_prompts ORDER BY provider`)
    .all() as { provider: string }[];
  return rows.map((r) => r.provider);
}

/** Distinct tasks present in the catalog. */
export function catalogTasks(): string[] {
  const rows = localDb()
    .prepare(`SELECT DISTINCT task FROM default_prompts ORDER BY task`)
    .all() as { task: string }[];
  return rows.map((r) => r.task);
}

/* ----------------------------- per-user provider API keys ----------------------------- */

/** The user's key row for a provider (includes api_key — internal use only). */
export function userProviderKey(userId: number, provider: string): UserProviderKeyRow | null {
  const row = localDb()
    .prepare(
      `SELECT provider, api_key, base_url FROM user_provider_keys
        WHERE user_id = ? AND provider = ? LIMIT 1`,
    )
    .get(userId, provider) as UserProviderKeyRow | undefined;
  return row ?? null;
}

/** The user's providers — the key value is never selected, only key_set. */
export function listUserProviderKeys(userId: number): UserProviderKeyListRow[] {
  const rows = localDb()
    .prepare(
      `SELECT provider,
              (api_key IS NOT NULL AND api_key <> '') AS key_set,
              base_url, updated_at
         FROM user_provider_keys
        WHERE user_id = ?
        ORDER BY provider`,
    )
    .all(userId) as (Omit<UserProviderKeyListRow, 'key_set'> & { key_set: number })[];
  return rows.map((r) => ({ ...r, key_set: Boolean(r.key_set) }));
}

/**
 * Insert or update a provider key. A null apiKey on update preserves the stored key (same
 * convention as /v1/model-prompts).
 */
export function upsertUserProviderKey(
  userId: number,
  provider: string,
  apiKey: string | null,
  baseUrl: string | null,
): void {
  if (apiKey === null) {
    apiKey = userProviderKey(userId, provider)?.api_key ?? null;
  }
  localDb()
    .prepare(
      `INSERT INTO user_provider_keys (user_id, provider, api_key, base_url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         api_key    = excluded.api_key,
         base_url   = excluded.base_url,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(userId, provider, apiKey, baseUrl);
}

/** Delete a provider key; returns true if a row was removed. */
export function deleteUserProviderKey(userId: number, provider: string): boolean {
  return (
    localDb()
      .prepare(`DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?`)
      .run(userId, provider).changes > 0
  );
}

/* ----------------------------- per-user task → model choices ----------------------------- */

/** The user's model choice for a task, or null. */
export function userModelChoice(userId: number, task: string): UserModelChoiceRow | null {
  const row = localDb()
    .prepare(
      `SELECT task, model_name, system_prompt FROM user_model_choices
        WHERE user_id = ? AND task = ? LIMIT 1`,
    )
    .get(userId, task) as UserModelChoiceRow | undefined;
  return row ?? null;
}

/** All of the user's task → model choices (the prompt override reported only as a flag). */
export function listUserModelChoices(userId: number): UserModelChoiceListRow[] {
  const rows = localDb()
    .prepare(
      `SELECT task, model_name,
              (system_prompt IS NOT NULL AND system_prompt <> '') AS system_prompt_override,
              updated_at
         FROM user_model_choices
        WHERE user_id = ?
        ORDER BY task`,
    )
    .all(userId) as (Omit<UserModelChoiceListRow, 'system_prompt_override'> & {
    system_prompt_override: number;
  })[];
  return rows.map((r) => ({ ...r, system_prompt_override: Boolean(r.system_prompt_override) }));
}

/** Insert or replace the user's model choice for a task. */
export function upsertUserModelChoice(
  userId: number,
  task: string,
  modelName: string,
  systemPrompt: string | null,
): void {
  localDb()
    .prepare(
      `INSERT INTO user_model_choices (user_id, task, model_name, system_prompt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, task) DO UPDATE SET
         model_name    = excluded.model_name,
         system_prompt = excluded.system_prompt,
         updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(userId, task, modelName, systemPrompt);
}

/** Delete the user's model choice for a task; returns true if a row was removed. */
export function deleteUserModelChoice(userId: number, task: string): boolean {
  return (
    localDb()
      .prepare(`DELETE FROM user_model_choices WHERE user_id = ? AND task = ?`)
      .run(userId, task).changes > 0
  );
}
