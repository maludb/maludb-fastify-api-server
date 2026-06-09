# Migration Notes — PHP/LAMP → TypeScript/Fastify

This server is a refactor of [`maludb/maludb-lamp-api-server`](https://github.com/maludb/maludb-lamp-api-server).
It preserves that project's philosophy (URL → route file → readable SQL → PostgreSQL) and ports the
endpoint surface faithfully. This document maps the old structure to the new.

## File / module mapping

| PHP | TypeScript |
|---|---|
| `html/v1/<name>.php` | `src/routes/v1/<name>.ts` (same name, `.ts`) |
| `html/.htaccess` (rewrite rules) | `src/http/route-map.ts` (explicit `register()` calls) |
| `config/response.php` `db_query/db_one/db_exec` | `src/db/query.ts` `dbMany/dbOne/dbExec` |
| `config/response.php` `db_tx_core` | `src/db/tx.ts` `dbTxCore` (and `dbTx`) |
| `config/response.php` `json_response/json_error/body_json` | `src/http/response.ts`, `src/http/request.ts`, `src/http/errors.ts` |
| `config/response.php` `require_auth/bearer_token/current_role` | `src/http/auth.ts` `requireAuth/bearerToken/currentRole` |
| `config/response.php` `sql_log` + `$__sql_trace` | `src/logging/sql-log.ts` + `ctx.sqlTrace` |
| `config/response.php` `api_log` + `handle_uncaught` | `src/logging/api-log.ts` + Fastify `setErrorHandler` (`src/app.ts`) |
| `config/response.php` SVPO/attribute/document/memory helpers | `src/db/statements.ts`, `src/db/attributes.ts`, `src/db/documents.ts`, `src/memory/memory-db.ts` |
| `config/llm.php` | `src/memory/llm.ts` (cURL → `fetch`) |
| `config/database.php` `Database` singleton + `configure()` | `src/db/postgres.ts` + `src/db/tenant.ts` (pool keyed by db/user/password) |
| `config/local-database.php` `LocalDatabase` (MySQL) | `src/local-db/local-db.ts` (SQLite via better-sqlite3) |
| `config/local-database.sql` (MySQL) | `src/local-db/schema.sql` (SQLite) |

## Behavioural deltas (intentional)

- **Local store engine:** MySQL → **SQLite** (`~/.maludb/api-server/config.sqlite`). The schema is a
  faithful *flat* port: a single `users` table (token hash + role + tenant pg creds) plus
  `model_prompts`. (The original brief proposed a normalized 3-table design; we kept the PHP's flat
  shape for a 1:1 port of the `/v1/tokens` logic.)
- **Per-request state:** PHP is shared-nothing (one process per request) and used request globals
  (`$__auth_user_id`, `$__sql_trace`) plus a per-request `Database::configure()`. Node serves many
  requests in one process, so all per-request state lives on a **`ctx` object** threaded through the
  DB helpers (`dbMany(ctx, …)`), and tenant connections are **pooled** (keyed by db/user/password)
  instead of reconnected per request.
- **Placeholders:** PDO `?` → node-postgres `$1, $2, …`.
- **Types:** node-postgres returns `bigint`/`numeric` as strings (coerced with `Number(...)`) and
  parses `json`/`jsonb` automatically (no second `JSON.parse`). See `docs/sql-style-guide.md`.
- **Log/config locations:** default to `~/.maludb/api-server/` (no root needed) instead of
  `/var/log/maludb` + system MySQL. All overridable via env (`MALUDB_CONFIG_DB`, `MALUDB_LOG_DIR`,
  `MALUDB_SQL_LOG`, `MALUDB_API_LOG`).
- **Method-not-allowed:** the `.htaccess` + PHP `switch default:` 405 becomes a Fastify
  not-found handler that returns `405 method_not_allowed` (with an `Allow` header) for a known URL
  and `404 not_found` otherwise.
- **`/v1/health`:** new endpoint with no PHP source (the PHP health/diag lived outside `/v1/`).

## Things that are identical on purpose

- Every endpoint's **SQL is the same SQL**, ported verbatim (column lists, CTEs, facade calls, casts).
- The bearer-token flow: `malu_<token>` → `sha256(body)` → local-store lookup → tenant pg creds + role.
- The error envelope `{ error: { code, message } }` and the PostgreSQL SQLSTATE → HTTP mapping
  (`23505`→409, `42501`→403, `23502/23503/23514/22xxx/22P02/P0001`→422, tenant conn → 502/503).
- The `?debug=1` SQL trace, gated on server `MALUDB_DEBUG=1`.
