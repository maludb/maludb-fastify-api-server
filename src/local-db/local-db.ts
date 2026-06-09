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
import type { ModelPromptRow, TokenRow, UserTokenRow } from '../types/auth.js';

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
