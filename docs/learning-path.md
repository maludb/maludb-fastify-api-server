# Learning Path

This server is a reference implementation for MaluDB SQL. The fastest way to learn MaluDB is to read
the route files in this order — each builds on the concepts of the last. Every file is literal SQL
behind an HTTP handler; open it and read the query.

| # | Read | URL | What it teaches |
|---|---|---|---|
| 1 | `routes/v1/health.ts` | `GET /v1/health` | The shape of an endpoint — no auth, no SQL. |
| 2 | `routes/v1/tokens.ts` + `http/auth.ts` | `POST /v1/tokens` | The auth/tenant model: a bearer token resolves to a Postgres connection + role. Token issuance proves the Postgres login. |
| 3 | `routes/v1/subjects.ts` | `GET POST /v1/subjects` | Subjects are the canonical SVPOR nodes. `subject_id`→`id`, `canonical_name`→`label`. Inline id derivation. |
| 4 | `routes/v1/verbs.ts` | `GET POST /v1/verbs` | Verbs are typed predicate nodes; the link table is keyed by name. |
| 5 | `routes/v1/subjects_id_verbs.ts` | `…/subjects/:id/verbs` | Linking a subject to a verb mints a per-pair vector compartment. |
| 6 | `routes/v1/documents.ts` | `POST /v1/documents` | Documents are first-class graph nodes; bytes live in `maludb_source_package`, tags become real edges. |
| 7 | `routes/v1/graph_neighbors.ts` | `GET /v1/graph/neighbors` | One labeled hop over the unified edge view, with direction + relationship filtering. |
| 8 | `routes/v1/edges.ts` | `GET /v1/edges` | `maludb_edge` unifies SVO statement edges and lineage edges under one read surface. |
| 9 | `routes/v1/episodes.ts` | `GET POST /v1/episodes` | An episode (event) is folded onto a subject; `maludb_register_episode` auto-mints it. |
| 10 | `routes/v1/statements.ts` | `GET POST /v1/statements` | A statement is `(subject,verb,object)`, idempotent; `?provenance=suggested` is the review queue. |
| 11 | `routes/v1/attributes.ts` | `GET POST /v1/attributes` | A typed property on any node OR edge, keyed on `(target_kind,target_id,attr_name)`. |
| 12 | `routes/v1/memory_search.ts` | `POST /v1/memory/search` | Embed the query and ANN-search a (subject,verb) vector compartment. The API is the model worker. |

## Supporting reading

- `db/query.ts` / `db/tx.ts` — how every query is executed, logged, and (for `dbTxCore`) run with the
  `maludb_core` search path the facade functions need.
- `db/statements.ts` / `db/attributes.ts` / `db/documents.ts` — the SVPO/attribute/document-graph
  facade helpers, shared because the same SQL is reused across a few endpoints.
- `memory/llm.ts` — the model-worker layer (chat, extraction, embeddings with a deterministic
  no-creds fallback, chunking).
- `docs/endpoint-map.md` — the full URL → file → SQL-objects catalog.
