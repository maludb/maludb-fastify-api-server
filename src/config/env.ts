/**
 * Environment configuration. The PostgreSQL host/port are fixed for the deployment (like the PHP
 * `Database::DB_HOST`/`DB_PORT` constants); the database name/user/password are resolved per request
 * from the API token, never from env. Everything else is optional with sane defaults.
 */

/** Fixed Postgres host for this deployment (tenant db/user/pass come from the token). */
export function pgHost(): string {
  return process.env.MALUDB_PG_HOST ?? '127.0.0.1';
}

/** Fixed Postgres port for this deployment. */
export function pgPort(): number {
  return intEnv('MALUDB_PG_PORT', 5432);
}

/** HTTP listen port for the API server. */
export function serverPort(): number {
  return intEnv('MALUDB_PORT', 8080);
}

/** HTTP listen host. */
export function serverHost(): string {
  return process.env.MALUDB_HOST ?? '0.0.0.0';
}

/** Server-side debug switch. `?debug=1` only adds meta.debug when this is also on (brief §12). */
export function debugEnabled(): boolean {
  return process.env.MALUDB_DEBUG === '1';
}

/** Outbound model HTTP timeout in seconds (memory pipeline). */
export function httpTimeoutMs(): number {
  return intEnv('MALUDB_HTTP_TIMEOUT', 60) * 1000;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
