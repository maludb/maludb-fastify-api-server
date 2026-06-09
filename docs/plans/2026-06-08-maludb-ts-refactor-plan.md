# MaluDB API Server — TypeScript Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port `maludb/maludb-lamp-api-server` (PHP/LAMP) into an npm-installable TypeScript +
Fastify server that preserves the URL → route file → readable SQL → PostgreSQL philosophy.

**Architecture:** One Fastify app, one route file per `/v1/...` URL (same names as the PHP files).
A thin per-request `ctx` carries the tenant Postgres pool, role, and SQL trace through small DB
helpers (`dbMany/dbOne/dbExec/dbTxCore`). A local **SQLite** store (flat `users` + `model_prompts`)
replaces the PHP local MySQL auth store. The API is also the LLM "model worker" for the memory
pipeline. No ORM; SQL stays literal in the route files.

**Tech Stack:** Node 24 LTS, TypeScript (strict), Fastify, `pg`, `better-sqlite3`, Vitest,
ESLint + Prettier, `tsx` for dev.

**Design doc:** `docs/plans/2026-06-08-maludb-ts-refactor-design.md` (read it first).

---

## Constraints & testing strategy (read before executing)

- **No live MaluDB Postgres here.** Endpoint SQL is ported faithfully from the PHP and verified by
  review, not by live round-trips. Integration tests that need Postgres **auto-skip unless
  `MALUDB_TEST_PG` (a connection string) is set**. `npm test` must be green without Postgres.
- **What IS unit-tested without Postgres:** SQLite store, token hashing/auth, request/param parsing,
  Postgres SQLSTATE→HTTP error mapping, SQL-log line format + secret redaction, the LLM layer
  (deterministic embedding, chunking, JSON-from-text parsing, OpenAI/Anthropic body shaping with a
  mocked `fetch`), server boot + `/v1/health`, missing/invalid-token 401s, 404, method-not-allowed,
  debug-gating.
- **Faithfulness rule (every endpoint):** open the matching PHP file in
  `/tmp/maludb-lamp-api-server/html/v1/`, port the **exact SQL** into the `.ts` route file with a
  teaching docblock. Do **not** refactor, "improve," or deduplicate the SQL. If the PHP derives an
  id with `COALESCE(MAX(...)+1)`, the TS does too.
- **Commit after every task.** Conventional commits. Branch: `feat/ts-refactor` (not `main`).
- The source repo is cloned read-only at `/tmp/maludb-lamp-api-server` (re-clone if missing).

## Pinned conventions (do not deviate)

**Helper API (these signatures are contracts the route files depend on):**
```ts
// src/db/query.ts
dbMany<T=Row>(ctx, sql, params?): Promise<T[]>
dbOne<T=Row>(ctx, sql, params?): Promise<T | null>
dbExec(ctx, sql, params?): Promise<number>            // returns rowCount
// src/db/tx.ts
dbTx<T>(ctx, fn: (tx) => Promise<T>): Promise<T>
dbTxCore<T>(ctx, fn: (tx) => Promise<T>): Promise<T>   // SET LOCAL search_path TO public, maludb_core
// src/http/response.ts
jsonResponse(reply, data, status=200): void            // attaches meta.debug when enabled
jsonError(code, message, status): never                // throws ApiError (caught by error handler)
// src/http/request.ts
pathId(request) / pathSubId(request): number
queryInt(request, name, def?, max?) / queryStr(request, name, def?, maxLen=200)
bodyObject(request): Record<string,unknown>            // 400 body_invalid_json / bad_request
// src/http/auth.ts
requireAuth(request): Promise<RequestCtx>
```
`dbMany/dbOne/dbExec` run on `ctx.client ?? ctx.pool`. Inside `dbTxCore`, `ctx.client` is set so all
helpers share the transaction connection (mirrors PHP's shared PDO).

**Route file format (canonical — every route file looks like this):**
```ts
/**
 * GET  /v1/subjects
 * POST /v1/subjects
 *
 * MaluDB concept: Subject catalog.
 * SQL objects: maludb_subject, maludb_subject_verb, maludb_subject_relationship,
 *              maludb_subject_with_attributes (?with=attributes)
 * Teaches: subject_id→id, canonical_name→label, verb links counted via maludb_subject_verb.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse, jsonError } from '../../http/response.js';
import { queryStr, queryInt, bodyObject } from '../../http/request.js';
import { attachAttributes } from '../../db/attributes.js';

export async function register(app: FastifyInstance) {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/subjects',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request);
      if (request.method === 'GET') { /* literal SQL → dbMany → jsonResponse */ }
      else { /* literal SQL → dbOne(INSERT…RETURNING) → jsonResponse(…, 201) */ }
    },
  });
}
```
Method-not-allowed: register only the methods the PHP `switch` handles; a Fastify `setNotFoundHandler`
+ per-route method list yields `405 method_not_allowed` with an `Allow` header where the PHP did.

**Naming:** route files keep the PHP names verbatim (hyphens preserved: `subject-types.ts`,
`attribute-templates.ts`, `subjects_id_related-subjects.ts`). Imported via `register`, so hyphens
are fine. Exported function is always `register`. Functions camelCase, types PascalCase, env
UPPER_SNAKE_CASE, SQL aliases match API field names.

---

## Phase 0 — Project scaffolding

### Task 0.1: package.json + tsconfig + tooling
**Files:** Create `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `.gitignore`,
`vitest.config.ts`, `.nvmrc`.
- `package.json`: `"type": "module"`, `bin: { "maludb-api-server": "dist/cli.js" }`,
  scripts `dev/build/start/init/migrate/test/lint` per brief §5.1, deps `fastify pg better-sqlite3`,
  devDeps `typescript tsx vitest @types/node @types/pg eslint prettier`.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitAny`, `module: NodeNext`,
  `moduleResolution: NodeNext`, `target: ES2022`, `outDir: dist`, `rootDir: src`.
- **Step — verify:** `npm install` succeeds; `npx tsc --noEmit` runs (no files yet → ok); commit.

### Task 0.2: directory skeleton + types
**Files:** Create `src/config/{env.ts,paths.ts}`, `src/types/{api.ts,auth.ts,db.ts}` (interfaces:
`RequestCtx`, `TenantConfig`, `SqlTraceEntry`, `TokenRow`, `ModelPromptRow`, `ApiErrorShape`).
- `config/paths.ts`: resolve `~/.maludb/api-server/` base, `config.sqlite`, `logs/` — honour
  `MALUDB_CONFIG_DB`, `MALUDB_LOG_DIR`, `MALUDB_SQL_LOG`.
- `config/env.ts`: `PG_HOST`, `PG_PORT`, `MALUDB_DEBUG`, `MALUDB_EMBED_*`, `MALUDB_LLM_TOKEN`,
  `MALUDB_HTTP_TIMEOUT`, port.
- **Verify:** `tsc --noEmit` clean; commit.

---

## Phase 1 — HTTP skeleton, logging, responses

### Task 1.1: SQL-log + api-log + redact (TDD)
**Files:** Create `src/logging/{sql-log.ts,api-log.ts,redact.ts}`; Test `tests/unit/logging.test.ts`.
- Test: `formatSqlLine(entry)` produces the exact multi-line block (timestamp, file, method, path,
  user, indented SQL, params JSON, rows, dur). `redactParams(params, [1])` → index 0 becomes
  `<redacted>`. Append writes to the resolved log path.
- Implement minimal; run; commit.

### Task 1.2: response + request helpers (TDD)
**Files:** Create `src/http/{response.ts,request.ts,errors.ts}`; Test `tests/unit/http.test.ts`.
- `ApiError` class (code, message, status). `jsonError` throws it. `jsonResponse` sets status +
  content-type, attaches `meta.debug` only when `MALUDB_DEBUG=1` AND `?debug=1`.
- `queryInt` clamps to max, rejects non-digits (400). `queryStr` truncates to maxLen. `pathId`/
  `pathSubId` require numeric (400 bad_request). `bodyObject` → 400 on invalid/array JSON.
- Test each; commit.

### Task 1.3: app + health + error handler + server (TDD)
**Files:** Create `src/app.ts`, `src/server.ts`, `src/routes/v1/health.ts`,
`src/http/route-map.ts`; Test `tests/unit/health.test.ts` (Fastify `inject`).
- `buildApp()`: registers routes via `route-map`, sets `setErrorHandler` (maps `ApiError` + pg errors
  → standard JSON, logs api.log, 500 stacks to log only), `setNotFoundHandler` (`404 not_found`),
  adds an `onResponse` hook → one api.log line per request.
- `health.ts`: `GET /v1/health` → `{status:'ok', ...}` (no auth).
- Test: `inject GET /v1/health` → 200 JSON; unknown path → 404 `not_found`; api.log gets a line.
- **Acceptance (brief Ph1):** `npm run dev` starts; `GET /v1/health` returns JSON; api.log writes
  one line per request. Commit.

---

## Phase 2 — Local SQLite config DB + CLI init/migrate

### Task 2.1: schema.sql (faithful flat port)
**Files:** Create `src/local-db/schema.sql`.
- `users(id PK, token_hash UNIQUE, token_prefix, user_id, role DEFAULT 'executor', pg_dbname,
  pg_user, pg_password, expires_at, device_name, created_at DEFAULT CURRENT_TIMESTAMP)` +
  `model_prompts(model_name PK, model_identifier, api_format DEFAULT 'openai', system_prompt,
  base_url, api_key, max_tokens DEFAULT 2048, generation_params, created_at, updated_at)`.
  SQLite types (TEXT/INTEGER), `CREATE TABLE IF NOT EXISTS`, index on `token_hash`.
- Idempotent (re-runnable). Commit.

### Task 2.2: local-db.ts accessor (TDD)
**Files:** Create `src/local-db/local-db.ts`; Test `tests/unit/local-db.test.ts` (temp file DB).
- `openLocalDb(path?)` (creates dirs, applies schema), `resolveToken(hash)` (expiry-aware, returns
  `{user_id, role, pg_dbname, pg_user, pg_password}` or null), `modelPrompt(model)`, `nextUserId()`,
  `insertToken(row)`, `listTokens(pg_dbname, pg_user)`, `revokeToken(...)`.
- Test: insert→resolve round-trip; expired token resolves null; unknown hash null; nextUserId
  increments. Commit.

### Task 2.3: CLI init + migrate (TDD)
**Files:** Create `src/cli.ts`; Test `tests/unit/cli.test.ts`.
- `maludb-api-server init` → creates `config.sqlite` + applies schema (idempotent). `migrate` →
  re-applies schema. `start` → boots server. (token subcommands in Phase 3.)
- **Acceptance (brief Ph2):** `init` creates config.sqlite; migrations idempotent; tables exist. Commit.

---

## Phase 3 — Token auth + CLI token commands

### Task 3.1: auth helper (TDD)
**Files:** Create `src/http/auth.ts`; Test `tests/unit/auth.test.ts`.
- `bearerToken(request)`, `requireAuth(request)`: missing → `401 auth_missing`; not `malu_` →
  `401 auth_invalid`; `sha256(body)` lookup miss → `401 auth_invalid`; hit → build `RequestCtx`
  (resolve tenant pool lazily), set role/tokenPrefix/userId. Never log full token.
- Test with a seeded temp SQLite: valid token → ctx with right user/role; missing/bad → correct 401
  codes; full token never appears in logs. Commit.

### Task 3.2: `/v1/tokens` + `/v1/tokens/:id` endpoints
**Files:** Create `src/routes/v1/tokens.ts`, `src/routes/v1/tokens_id.ts`.
- Port faithfully: `tokens.ts` POST mints `malu_<base64url(32 bytes)>`, stores `sha256(body)` + 8-char
  prefix, authorizes by `testCredentials(pg_*)` (Postgres connection test — see Phase 4 `tenant.ts`);
  GET lists tokens for a connection (metadata only, never token/password). `tokens_id.ts` per PHP
  (read/revoke). Returns token once (201).
- **Acceptance (brief Ph3):** missing→401 auth_missing; bad→401 auth_invalid; valid attaches
  user+tenant; full token never logged. Commit.

### Task 3.3: CLI `token create|list|revoke`
**Files:** Modify `src/cli.ts`.
- Operate on the flat `users` table; `create` verifies pg creds via `testCredentials`. Commit.

---

## Phase 4 — Postgres pool + query/tx/errors + tenant

### Task 4.1: error normalization (TDD)
**Files:** Create `src/db/errors.ts`; Test `tests/unit/db-errors.test.ts`.
- `TenantDbError(isAuthFailure)`. `mapPgError(err)` → `{status, code, message}` per §5 table
  (`23505`→409 conflict, `42501`→403 insufficient_privilege, `23502/23503/23514/22000/22023/22P02/
  P0001`→422 validation_failed, TenantDbError→502/503, else 500). Strip "ERROR: …" line.
- Test each SQLSTATE → expected mapping. Wire into the Fastify `setErrorHandler`. Commit.

### Task 4.2: tenant pool manager (TDD where possible)
**Files:** Create `src/db/postgres.ts`, `src/db/tenant.ts`; Test `tests/unit/tenant.test.ts`.
- `getPool(tenant)`: cache `pg.Pool` keyed by `db|user|password` (host/port from env). `testCredentials(tenant)`
  → bool (tries a connection, 5s timeout). `shutdownPools()` on server close.
- Connection failure → `TenantDbError` classified auth (28xxx / "authentication failed") vs
  unavailable. Test the key/cache logic + classification with a mock; live connect test skipped
  unless `MALUDB_TEST_PG`. Commit.

### Task 4.3: query + tx helpers (TDD)
**Files:** Create `src/db/query.ts`, `src/db/tx.ts`; Test `tests/unit/query.test.ts`.
- `dbMany/dbOne/dbExec`: prepare+execute on `ctx.client ?? ctx.pool`, measure duration, push to
  `ctx.sqlTrace`, write `sql.log`. `dbTx`/`dbTxCore`: acquire client, set `ctx.client`, `BEGIN`,
  (`SET LOCAL search_path TO public, maludb_core` for `dbTxCore`), run fn, COMMIT/ROLLBACK, release.
- Test trace/log capture + tx client-sharing with a fake client; live query test skipped unless
  `MALUDB_TEST_PG`.
- **Acceptance (brief Ph4):** every query logged; duration recorded; `?debug=1` shows SQL only when
  server debug enabled; pg credential failure → tenant_db_auth_failed/unavailable. Commit.

### Task 4.4: domain helper modules (port verbatim)
**Files:** Create `src/db/statements.ts` (`svporCreateStatement`, `shapeStatement`, cols),
`src/db/attributes.ts` (`svporCreateAttribute`, `shapeAttribute`, `attachAttributes`),
`src/db/documents.ts` (`documentLinkSubject/unlink/neighbors`, `documentLinkSpec`),
`src/db/redacted.ts` (`dbOneRedacted`). Test the pure shapers in `tests/unit/shapers.test.ts`.
- Port the exact SQL/logic from `config/response.php`. These run inside `dbTxCore` at call sites.
  Commit per module.

---

## Phase 5 — Read-only core endpoints (port the exact SQL)

For EACH endpoint below: read the PHP file, create `src/routes/v1/<name>.ts` with the canonical
format + teaching docblock, port the exact SELECT(s), register in `route-map.ts`, tick it in
`docs/endpoint-map.md`. Group commits by family. (GET-only or GET portion of mixed files first.)

- **Subjects (read):** `subjects.ts` (GET), `subjects_id.ts` (GET) — canonical example, do first.
- **Verbs (read):** `verbs.ts` (GET), `verbs_id.ts` (GET), `verbs_id_subjects.ts`.
- **Links/relationships (read):** `subjects_id_verbs.ts`, `subjects_id_verbs_id.ts` (GET),
  `subjects_id_related-subjects.ts` (GET), `subject-relationships_id.ts` (GET).
- **Types:** `subject-types.ts`, `verb-types.ts`, `episode-types.ts`, `episode-types_id.ts` (GET),
  `document-types.ts`, `document-types_id.ts` (GET).
- **Objects / handles:** `objects.ts` (GET), `objects_id.ts` (GET) — `/v1/objects/:kind/:id`.
- **Edges + Graph:** `edges.ts` (GET), `graph_neighbors.ts`, `graph_walk.ts` — keep graph SQL visible.
- **Documents (read):** `documents.ts` (GET), `documents_id.ts` (GET).
- **Episodes/Statements/Attributes (read):** `episodes.ts` (GET), `episodes_id.ts` (GET),
  `episodes_id_statements.ts` (GET), `statements.ts` (GET), `statements_id.ts` (GET),
  `attributes.ts` (GET), `attributes_id.ts` (GET), `attribute-templates.ts` (GET),
  `attribute-templates_id.ts` (GET), `attribute-check.ts`.
- **Projects/Pools/Skills/Notes (read):** GET portions of `projects*.ts`, `pools*.ts`, `skills*.ts`,
  `notes.ts`/`notes_id.ts`.
- **Acceptance (brief Ph5):** each route file has literal SQL + teaching docblock; responses match
  PHP shape; sql.log identifies the endpoint file. Commit per family.

---

## Phase 6 — Write endpoints (POST/PATCH/DELETE)

Add the write methods to the route files (same files as read where the PHP `switch` combines them),
porting the exact write SQL. Use `dbTxCore` wherever the PHP does (statements, attributes, document
links, type pickers, graph facades). Stable JSON validation errors.

- Subjects/Verbs writes (incl. inline `COALESCE(MAX+1)` id derivation), subject↔verb link
  create/delete, related-subjects create/delete + `subject-relationships_id` delete.
- Projects (create/patch/archive/unarchive, project↔subject, project↔verb), Pools (+archive),
  Skills (+duplicate), document-types/episode-types/attribute-templates writes.
- Documents (create/patch/delete metadata, `documents-backfill`), Notes (create/patch + `close-issue`
  / `reopen-issue`), Episodes, Statements (`svporCreateStatement` in `dbTxCore`), Attributes
  (`svporCreateAttribute` in `dbTxCore`), Objects (atomic create).
- **Acceptance (brief Ph6):** write SQL visible; stable error JSON; transactions where required;
  `dbTxCore` for search-path-sensitive facades. Commit per family.

---

## Phase 7 — Memory + LLM model-worker

### Task 7.1: LLM layer (TDD)
**Files:** Create `src/memory/llm.ts`; Test `tests/unit/llm.test.ts`.
- Port `config/llm.php`: `memEmbed` (deterministic sha256 unit vector fallback; real provider when
  `MALUDB_EMBED_*` set), `memEmbedDim`, `memChunk`, `llmChat`, `llmComplete` (openai+anthropic),
  `llmJsonFromText`, `memExtract`, `memDefaultPrompt`, `memVectorLiteral`, `httpPost` (fetch + timeout).
- Test (no creds needed): deterministic embedding — same text → identical normalized vector of
  `memEmbedDim()`; chunking boundaries + overlap; `llmJsonFromText` handles raw/fenced/embedded JSON;
  openai vs anthropic request body shape via mocked `fetch`. Commit.

### Task 7.2: memory endpoints (port verbatim)
**Files:** `src/routes/v1/{memory_search.ts,memory_ingest.ts,memory_documents.ts,memory_config.ts,
model-prompts.ts}`.
- Keep MaluDB memory SQL visible in the route files; LLM/embedding helpers do not hide schema
  interactions. `memory_ingest` uses `modelPrompt` from SQLite + `db_one_redacted` for token-bearing
  writes.
- **Acceptance (brief Ph7):** memory search + ingest SQL visible; LLM helpers don't hide MaluDB SQL.
  Commit.

---

## Phase 8 — Tests, docs, curl, README

- **Docs:** finalize `docs/endpoint-map.md` (from the catalog), `docs/sql-style-guide.md`,
  `docs/learning-path.md`, `docs/migration-notes.md`, `README.md` (install/init/migrate/token/start,
  env vars, MALUDB_TEST_PG note).
- **Integration tests:** `tests/integration/*` gated on `MALUDB_TEST_PG`; a local SQLite fixture for
  auth-path tests (valid token → reaches handler; tenant-down → 503). Sample curl commands that work
  against `npm run dev`.
- **Acceptance (brief Ph8):** `npm test` runs green (Postgres tests skip cleanly); curl examples
  documented; README documents local setup. Final commit.

---

## Definition of Done (brief §22)

Installs via npm · starts via CLI · SQLite local config · connects to tenant Postgres · bearer-token
tenant resolution · full endpoint surface ported · every endpoint keeps readable SQL in its route
file · every SQL statement logged · `?debug=1` shows executed SQL when enabled · a developer can
learn MaluDB by reading the route files.
