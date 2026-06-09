# maludb-api-server

A readable **TypeScript + Fastify** reference implementation of the MaluDB API. It is both a
production API and a teaching artifact: one route file per endpoint, with the **SQL kept literal and
visible** in the handler. A developer can open any endpoint, read the SQL, and learn how MaluDB works.

```
URL → route file → readable SQL → PostgreSQL
```

This is a refactor of [`maludb/maludb-lamp-api-server`](https://github.com/maludb/maludb-lamp-api-server)
(PHP/LAMP) into an npm-installable Node service. See [`docs/migration-notes.md`](docs/migration-notes.md).

## Requirements

- Node.js 20+ (LTS)
- A MaluDB **PostgreSQL** database to point at (host/port fixed per deployment; per-tenant
  database/user/password are resolved from API tokens)

## Install

```bash
npm install
npm run build        # compiles to dist/ and copies the local-db schema
```

Or, once published, install the CLI globally: `npm i -g maludb-api-server`.

## Configure

The PostgreSQL **host/port** are the only fixed deployment values (the database/user/password come
from each API token):

```bash
export MALUDB_PG_HOST=127.0.0.1     # default 127.0.0.1
export MALUDB_PG_PORT=5432          # default 5432
export MALUDB_PORT=8080             # API listen port (default 8080)
```

The local config DB and logs default to `~/.maludb/api-server/` and need no root. Overrides:

| Env | Purpose | Default |
|---|---|---|
| `MALUDB_CONFIG_DB` | SQLite config DB path | `~/.maludb/api-server/config.sqlite` |
| `MALUDB_LOG_DIR` | log directory | `~/.maludb/api-server/logs` |
| `MALUDB_SQL_LOG` / `MALUDB_API_LOG` | individual log files | `<logs>/sql.log`, `<logs>/api.log` |
| `MALUDB_DEBUG` | set `1` to allow `?debug=1` SQL traces in responses | off |
| `MALUDB_EMBED_BASE_URL` / `_TOKEN` / `_MODEL` / `MALUDB_EMBED_DIM` | real embedding provider | deterministic fallback |
| `MALUDB_LLM_TOKEN` | fallback LLM token for the memory pipeline | — |

## Initialize & run

```bash
maludb-api-server init        # create the SQLite config DB + schema
maludb-api-server migrate     # (re-)apply the schema, idempotent
maludb-api-server start       # start the API server
# or, for development:
npm run dev
```

Health check:

```bash
curl localhost:8080/v1/health
# {"status":"ok","name":"maludb-api-server","version":"0.1.0","time":"…"}
```

## Tokens

Authorization is the Postgres login itself: to mint a token you supply working
`pg_dbname`/`pg_user`/`pg_password`, which the server verifies by connecting. The plaintext token is
returned **once**; only its `sha256` hash is stored.

```bash
# via CLI
maludb-api-server token create --db mydb --user myuser --password secret --role executor
maludb-api-server token list   --db mydb --user myuser --password secret
maludb-api-server token revoke 3 --db mydb --user myuser --password secret

# via HTTP
curl -X POST localhost:8080/v1/tokens \
  -H 'content-type: application/json' \
  -d '{"pg_dbname":"mydb","pg_user":"myuser","pg_password":"secret"}'
```

Then call any endpoint with the token:

```bash
curl localhost:8080/v1/subjects -H "Authorization: Bearer malu_…"
```

## Endpoints

See [`docs/endpoint-map.md`](docs/endpoint-map.md) for the full catalog (URL → file → SQL objects →
what it teaches). Start with [`docs/learning-path.md`](docs/learning-path.md).

## Develop

```bash
npm run dev          # tsx dev server
npm test             # unit suite (no Postgres needed — see below)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

### Testing without Postgres

The unit suite runs green with **no database**: it covers the local store, auth, error mapping,
request/param parsing, the SQL-log format, and the LLM layer (deterministic embedding, chunking,
JSON extraction, OpenAI/Anthropic request shaping). Endpoint round-trip tests that need a live MaluDB
PostgreSQL are gated behind `MALUDB_TEST_PG` and skip cleanly when it is unset.

```bash
# to also run the Postgres-backed integration tests:
MALUDB_TEST_PG='postgresql://user:pass@host:5432/db' npm test
```

## License

MIT
