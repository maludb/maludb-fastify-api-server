# SQL Style Guide

The SQL in this server is **teaching material**. A developer opening a route file should be able to
read the query and understand what MaluDB is doing. These rules keep it that way.

## Rules

1. **Readable, multi-line SQL.** Write queries the way you would in a SQL console — line breaks,
   aligned clauses, one column per line in long lists. Do not collapse to one line.
2. **Explicit column lists.** Name the columns you select (and alias them to the API field names).
   Avoid `SELECT *` — the reader should see the shape.
3. **Clear aliases that match the API response.** `s.subject_id AS id`, `s.canonical_name AS label`.
   The alias is the contract.
4. **Prefer CTEs when they improve readability.** A `WITH` that names a step beats a nested subquery
   the reader has to unwind.
5. **Comment non-obvious MaluDB concepts** inline (e.g. why a facade needs the `maludb_core` search
   path, or why an id is derived with `COALESCE(MAX+1)`).
6. **Positional parameters only.** node-postgres uses `$1, $2, …` (1-based). Reuse the same `$N` when
   the same value appears twice (e.g. a `%q%` in two `ILIKE`s). Never use string interpolation for
   values — the only thing you may interpolate is a server-validated integer (e.g. a clamped `LIMIT`)
   or an endpoint-constant identifier (a fixed view/column name, never user input).
7. **Never concatenate untrusted input into SQL.** All user input is a bound parameter.
8. **Keep search-path-sensitive calls inside `dbTxCore`.** The maludb_* facade views/functions
   resolve their `malu$*` base tables only when `maludb_core` is on the path. `dbTxCore` layers
   `maludb_core, public` onto the login search_path per transaction (`SET LOCAL` semantics), so a
   tenant schema pinned on the role stays first and `current_schema()` keeps resolving to it.
9. **Keep graph, memory, SVPOR, and attribute SQL visible in the endpoint file.** Do not push it into
   a repository layer. The shared `db/statements.ts`, `db/attributes.ts`, and `db/documents.ts`
   helpers exist only because the PHP shared them too (and they keep their SQL literal and visible).
10. **Do not prematurely deduplicate SQL** if doing so hides the learning value. Two endpoints with
    similar-but-not-identical queries should each show their own query.

## node-postgres specifics (vs PHP PDO)

- **Placeholders:** PDO `?` → pg `$1, $2, …`. This is the single most common porting edit.
- **Big integers & numerics come back as strings.** `bigint`/`numeric` columns are returned as JS
  strings. Coerce with `Number(...)` wherever the PHP did `(int)`/`(float)` (the row shapers in
  `db/statements.ts` / `db/attributes.ts` do this for SVPO rows).
- **`json`/`jsonb` columns are already parsed** into JS values — do not `JSON.parse` them again. When
  *binding* a JSON value, `JSON.stringify(...)` it and cast `$N::jsonb` in the SQL.
- **Postgres array columns** are returned as JS arrays (of strings); cast elements as needed. Bind a
  JS `string[]`/`number[]` for a Postgres array parameter.
- **`bytea`:** bind a Node `Buffer` directly.

## Example

```ts
const sql = `
  SELECT
    e.edge_id      AS id,
    e.from_kind,
    e.from_id,
    e.relationship,
    e.to_kind,
    e.to_id,
    e.provenance,
    e.confidence
  FROM maludb_edge e
  WHERE
    ($1::text   IS NULL OR e.from_kind = $1)
    AND ($2::bigint IS NULL OR e.from_id = $2)
  ORDER BY e.edge_id DESC
  LIMIT $3
`;
const edges = await dbMany(ctx, sql, [fromKind, fromId, limit]);
```
