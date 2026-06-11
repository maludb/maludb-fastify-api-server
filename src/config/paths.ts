/**
 * Filesystem locations for the npm-installed server.
 *
 * Mirrors the PHP layout but rooted under the user's home so a plain `npm i -g` install needs no
 * root: config DB + logs live in `~/.maludb/api-server/`. Every path honours an env override
 * (requirements §6, §10, §11).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.maludb/api-server` — the base for the SQLite config DB and the log directory. */
export function baseDir(): string {
  return process.env.MALUDB_HOME ?? join(homedir(), '.maludb', 'api-server');
}

/** SQLite config DB. Override with MALUDB_CONFIG_DB (brief §6). */
export function configDbPath(): string {
  return process.env.MALUDB_CONFIG_DB ?? join(baseDir(), 'config.sqlite');
}

/** Log directory. Override with MALUDB_LOG_DIR (default `<base>/logs`). */
export function logDir(): string {
  return process.env.MALUDB_LOG_DIR ?? join(baseDir(), 'logs');
}

/** Every executed SQL statement (requirements §10). Override with MALUDB_SQL_LOG. */
export function sqlLogPath(): string {
  return process.env.MALUDB_SQL_LOG ?? join(logDir(), 'sql.log');
}

/** One line per request + 500 stacks (requirements §11). Override with MALUDB_API_LOG. */
export function apiLogPath(): string {
  return process.env.MALUDB_API_LOG ?? join(logDir(), 'api.log');
}

/** The local-db schema.sql, resolved next to the compiled/sourced module that loads it. */
export function schemaSqlPath(moduleDir: string): string {
  return join(moduleDir, 'schema.sql');
}

/**
 * The seeded LLM prompt files (config/prompts/), resolved relative to the module that loads
 * them (src/local-db or dist/local-db). The build copies config/prompts → dist/config/prompts
 * (scripts/copy-assets.mjs), so the compiled tree finds them one level up; when running from
 * source (tsx), they resolve to the repo's config/prompts.
 */
export function promptsDir(moduleDir: string): string {
  const inDist = join(moduleDir, '..', 'config', 'prompts'); // dist/local-db → dist/config/prompts
  if (existsSync(inDist)) return inDist;
  return join(moduleDir, '..', '..', 'config', 'prompts'); // src/local-db → <repo>/config/prompts
}
