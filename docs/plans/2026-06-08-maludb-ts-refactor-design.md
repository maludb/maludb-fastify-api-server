# MaluDB API Server — TypeScript Refactor Design

**Date:** 2026-06-08
**Source of truth:** `maludb/maludb-lamp-api-server` (PHP/LAMP). This is a *refactor* of that
repo into an npm-installable TypeScript + Fastify server — a TypeScript evolution of the same
philosophy, not a reimagining.

## 1. Guiding principle (unchanged)

```
URL → route file → readable SQL → PostgreSQL
```

The server is simultaneously a production API and a **teaching/reference implementation for
MaluDB SQL**. A developer opens a route file and sees: the URL, the methods, the exact SQL, the
bound params, the JSON shape, and the MaluDB concept it teaches. No ORM, no repository layer, no
query builder, no hidden domain logic. SQL stays literal and visible in the route file.

## 2. What the source actually is (reconnaissance summary)

- **One shared module** does everything: `config/response.php`. It contains the DB wrappers, four
  domain-helper families, response/error helpers, bearer auth, request/param parsing, and a global
  error handler. Everything else is one PHP file per endpoint that `require`s it.
- **~59 endpoint files** in `html/v1/` (the brief listed ~40). The full surface adds:
  `projects` (+archive/unarchive/subjects/verbs), `pools` (+archive), `skills` (+duplicate),
  `document-types`, `memory_config`, `memory_documents`, `model-prompts`.
- **Tenant model:** PostgreSQL `DB_HOST`/`DB_PORT` are fixed per deployment. The database
  **name/user/password are resolved per request from the API token** and applied before any query.
- **Local auth store** is MySQL today: a single flat `users` table (token_hash + role + pg creds)
  plus a `model_prompts` table. The token is stored only as `sha256(token-after-malu_)`.
- **`.htaccess`** is purely mechanical URL→file rewriting. Nothing application-level lives there.
- **LLM layer** (`config/llm.php`): Postgres can't make outbound HTTP, so the API is the model
  worker — OpenAI + Anthropic chat, embeddings (with a deterministic no-creds fallback), chunking.

## 3. Reconciliation decisions (locked)

| Topic | Source (PHP) | Brief §6.1 | **Decision** |
|---|---|---|---|
| Local config DB engine | MySQL | SQLite | **SQLite** (`better-sqlite3`) |
| Local schema shape | flat `users` + `model_prompts` | normalized 3-table | **Faithful flat port**: one `users` table + `model_prompts` |
| Endpoint surface | ~59 files | ~40 | **Full surface** — port all ~59 |
| SQLite driver | — | unspecified | **`better-sqlite3`** (synchronous, maps 1:1 to PDO usage, prebuilt binaries) |
| Route framework | none (.htaccess) | Fastify | **Fastify**, restrained — registration is a mechanical mapping layer only |

Rationale for the flat store: the source `/v1/tokens` endpoint authorizes purely by testing the
supplied Postgres credentials and writes one `users` row per token. A flat table is a 1:1 port of
that logic and keeps the token SQL as readable as the rest. We add `model_prompts` (the brief
omitted it) because `/v1/memory/ingest` needs per-model extraction prompts + LLM connection.

## 4. The PHP→TypeScript mapping

The single `response.php` is split along the brief's module boundaries. **Behaviour is identical;
only the seams change.**

| PHP (`config/response.php`) | TypeScript |
|---|---|
| `db_query / db_one / db_exec` | `src/db/query.ts` → `dbMany(ctx,sql,p) / dbOne(ctx,sql,p) / dbExec(ctx,sql,p)` |
| `db_tx_core(fn)` (SET LOCAL search_path) | `src/db/tx.ts` → `dbTxCore(ctx, async tx => …)`, plus `dbTx` |
| `sql_log()` + `$GLOBALS['__sql_trace']` | `src/logging/sql-log.ts` writing to `ctx.sqlTrace` + `sql.log` |
| `api_log()` + `handle_uncaught()` | `src/logging/api-log.ts` + Fastify `setErrorHandler` |
| `json_response / json_error / body_json` | `src/http/response.ts`, `src/http/request.ts` |
| `require_auth() / bearer_token() / current_role()` | `src/http/auth.ts` → `requireAuth(request): RequestCtx` |
| `Database` singleton + `configure()` | `src/db/postgres.ts` + `src/db/tenant.ts` (pool keyed by db/user/pass) |
| `LocalDatabase` (MySQL) | `src/local-db/local-db.ts` (better-sqlite3) |
| SVPO / attribute / document / memory helpers | ported verbatim into `src/db/*` + `src/memory/*` |
| `config/llm.php` | `src/memory/llm.ts` (fetch instead of cURL) |
| `.htaccess` rewrite rules | `src/http/route-map.ts` (explicit `register()` calls) |
| `html/v1/<name>.php` | `src/routes/v1/<name>.ts` (same name, `.ts`) |

### 4.1 The key structural change: per-request `ctx`

PHP is shared-nothing (one process per request) and uses globals for the SQL trace and the
configured connection. Node serves many requests concurrently in one process, so **all per-request
state moves onto a `ctx` object** that threads through the DB helpers — which is exactly what the
brief's `dbMany(ctx, …)` signature is for.

```ts
interface RequestCtx {
  userId: number | 'anon';
  role: string | null;
  tokenPrefix: string | null;
  tenant: { dbname: string; user: string; password: string }; // host/port fixed in env
  pool: Pool;                 // tenant pool, keyed by (db,user,password)
  client?: PoolClient;        // set inside dbTxCore so helpers share the tx connection
  sqlTrace: SqlTraceEntry[];  // feeds ?debug=1 meta.debug
  endpointFile: string;       // e.g. "subjects.ts" — for sql.log + debug
}
```

`dbMany/dbOne/dbExec` run on `ctx.client ?? ctx.pool`, mirroring how PHP's helpers all share the
one PDO handle inside a transaction (so `dbTxCore`'s `SET LOCAL search_path TO public, maludb_core`
applies to every query in the callback).

## 5. Cross-cutting behaviour to preserve exactly

- **Auth:** `Authorization: Bearer malu_<token>` → strip prefix → `sha256` hex → look up in SQLite
  `users` (reject if missing/expired) → resolve tenant pg creds + role → build `ctx`. Never log the
  full token; log only `token_prefix`, `user_id`, `role`. (`401 auth_missing` / `401 auth_invalid`.)
- **Error mapping** (`handle_uncaught`): tenant connection failure → `502 tenant_db_auth_failed` /
  `503 tenant_db_unavailable`; Postgres SQLSTATE `23505`→409 conflict, `42501`→403,
  `23502/23503/23514/22xxx/22P02/P0001`→422 validation_failed; everything else → 500. Stable JSON
  error body `{error:{code,message}}`; stack traces only to `api.log`, never to the client.
- **SQL log** (`sql.log`): timestamp · endpoint file · method · path · user · SQL · params · rows ·
  duration. **api log** (`api.log`): one line per request + 500 stacks. Default dir `~/.maludb/api-server/logs`
  (PHP used `/var/log/maludb`); overridable via `MALUDB_LOG_DIR` / `MALUDB_SQL_LOG`.
- **Debug:** `?debug=1` **and** `MALUDB_DEBUG=1` → attach `meta.debug = {file, queries[]}`.
- **Secret redaction:** memory writes that bind a token use a redacted SQL-log path (`<redacted>`).

## 6. Domain helper families (ported verbatim, kept visible)

These are the only "shared application code" beyond the thin wrappers — ported faithfully because
they encode MaluDB facade semantics, not generic CRUD:

1. **SVPO statements** — `svpor_create_statement()` (resolve verb/predicate, create-or-resolve
   person subject, `maludb_svpor_statement_create(...)`), `shape_statement()`, column list. Used by
   `statements.ts` + `episodes_id_statements.ts`, always inside `dbTxCore`.
2. **Typed attributes** — `svpor_create_attribute()` (`maludb_svpor_attribute_create`),
   `shape_attribute()`, `attach_attributes()` for `?with=attributes` via `*_with_attributes` views.
3. **Document ↔ graph links** — `document_link_subject / unlink / neighbors` (mirror
   `maludb_upload_document`: real edge + soft tag, primary-project repointing).
4. **Memory pipeline** — `mem_vector_literal`, `mem_resolve_token` (Postgres secret → env fallback),
   `db_one_redacted`. Plus the LLM module (chat/extract/embed/chunk).

## 7. Project layout (target)

Follows the brief §4, adjusted to the real surface. Route files keep the PHP names (hyphens
preserved for URL traceability; imported via `register()` so hyphens cause no friction):

```
src/
  cli.ts server.ts app.ts
  config/        env.ts paths.ts
  local-db/      local-db.ts schema.sql
  db/            postgres.ts tenant.ts query.ts tx.ts errors.ts
  http/          response.ts request.ts auth.ts route-map.ts
  logging/       sql-log.ts api-log.ts redact.ts
  memory/        llm.ts            (the model-worker layer)
  routes/v1/     ~59 endpoint files (one per URL)
  types/         api.ts auth.ts db.ts
docs/            endpoint-map.md sql-style-guide.md learning-path.md migration-notes.md
tests/           unit/ integration/
```

## 8. npm / CLI surface (brief §5)

`package.json` `bin: { "maludb-api-server": "dist/cli.js" }`; scripts `dev/build/start/init/migrate/test/lint`.
CLI: `init`, `migrate`, `start`, `token create|list|revoke`. CLI token commands operate on the flat
SQLite `users` table and verify Postgres credentials the same way `/v1/tokens` does.

## 9. Out of scope (brief §21)

No Prisma/ORM, GraphQL, admin UI, OpenAPI generator, Redis, job queue, DI container, clustering.

## 10. Execution

Phased per brief §18 (skeleton → SQLite store → auth → pg/query helpers → read endpoints → write
endpoints → memory/LLM → tests). Detailed task plan in `docs/plans/2026-06-08-maludb-ts-refactor-plan.md`.
Faithfulness rule for every endpoint: **read the PHP file, port the exact SQL into the `.ts` route
file with the teaching docblock, do not refactor the SQL.**
