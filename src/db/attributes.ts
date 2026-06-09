/**
 * Typed-attribute helpers (maludb_core) — shared by `attributes.ts` and `attributes_id.ts`. An
 * attribute is a typed property on any node OR edge, addressed by (target_kind, target_id);
 * target_kind includes 'svpor_statement' so graph edges carry attributes too. Upserted (on
 * target+attr_name) via the idempotent `maludb_svpor_attribute_create(...)` facade. Callers run
 * `svporCreateAttribute()` inside `dbTxCore()`. Ported verbatim from the PHP `config/response.php`.
 */
import { dbMany, dbOne } from './query.js';
import { dbTxCore } from './tx.js';
import { isNumeric, toNumOrNull } from './coerce.js';
import { jsonError } from '../http/errors.js';
import type { RequestCtx, Row } from '../types/db.js';

/** Read-side column list for a maludb_svpor_attribute row. */
export function svporAttributeCols(): string {
  return `attribute_id AS id, target_kind, target_id, attr_name,
          value_timestamp, value_range, value_numeric, value_text, value_jsonb,
          unit, provenance, confidence, valid_from, valid_to,
          metadata_jsonb AS metadata, created_at, ref_source, ref_entity, ref_key`;
}

/** Normalize scalar types on an attribute row in place (jsonb is already parsed by node-pg). */
export function shapeAttribute(r: Row): void {
  for (const k of ['id', 'target_id']) r[k] = toNumOrNull(r[k]);
  for (const k of ['value_numeric', 'confidence']) r[k] = toNumOrNull(r[k]);
  if (r.value_jsonb === undefined) r.value_jsonb = null;
  if (r.metadata === undefined) r.metadata = null;
  // value_range (tstzrange) is left as its text form.
}

export interface ForceTarget {
  kind: string;
  id: number;
}

/**
 * Create/upsert an attribute from a request body and return the (shaped) row. MUST run inside
 * `dbTxCore()`. Upsert is on (target_kind, target_id, attr_name). `forceTarget` overrides
 * target_kind/target_id (scoped routes). All shape/required checks run before any DB write.
 */
export async function svporCreateAttribute(
  ctx: RequestCtx,
  body: Record<string, unknown>,
  forceTarget: ForceTarget | null = null,
): Promise<Row> {
  // ---- phase 1: parse + shape-validate (no DB writes) ----
  let targetKind: string;
  let targetId: number;
  if (forceTarget !== null) {
    targetKind = String(forceTarget.kind);
    targetId = Number(forceTarget.id);
  } else {
    targetKind = body.target_kind !== undefined ? String(body.target_kind).trim() : '';
    if (targetKind === '') jsonError('missing_field', 'Field "target_kind" is required.', 400);
    if (body.target_id === undefined || !Number.isInteger(body.target_id)) {
      jsonError('validation_failed', '"target_id" must be an integer.', 422);
    }
    targetId = body.target_id as number;
  }

  const attrName = body.attr_name !== undefined ? String(body.attr_name).trim() : '';
  if (attrName === '') jsonError('missing_field', 'Field "attr_name" is required.', 400);

  for (const k of ['value_numeric', 'confidence']) {
    if (k in body && body[k] !== null && !isNumeric(body[k])) {
      jsonError('validation_failed', `"${k}" must be a number.`, 422);
    }
  }

  const valueTimestamp = body.value_timestamp !== undefined ? String(body.value_timestamp) : null;
  const valueRange = body.value_range !== undefined ? String(body.value_range) : null;
  const valueNumeric = 'value_numeric' in body && body.value_numeric !== null ? String(body.value_numeric) : null;
  const valueText = body.value_text !== undefined ? String(body.value_text) : null;
  const valueJsonb =
    'value_jsonb' in body && body.value_jsonb !== null ? JSON.stringify(body.value_jsonb) : null;
  const unit = body.unit !== undefined ? String(body.unit) : null;
  const provenance =
    body.provenance !== undefined && String(body.provenance).trim() !== ''
      ? String(body.provenance)
      : 'provided';
  const confidence = 'confidence' in body && body.confidence !== null ? String(body.confidence) : null;
  const validFrom = body.valid_from !== undefined ? String(body.valid_from) : null;
  const validTo = body.valid_to !== undefined ? String(body.valid_to) : null;
  const metadata =
    body.metadata !== undefined && body.metadata !== null && typeof body.metadata === 'object'
      ? JSON.stringify(body.metadata)
      : '{}';
  const refSource = body.ref_source !== undefined ? String(body.ref_source) : null;
  const refEntity = body.ref_entity !== undefined ? String(body.ref_entity) : null;
  const refKey = body.ref_key !== undefined ? String(body.ref_key) : null;

  // ---- phase 2: upsert via the facade (named args; idempotent on target+attr_name) ----
  const row = await dbOne(
    ctx,
    `SELECT maludb_svpor_attribute_create(
                p_target_kind     => $1, p_target_id => $2, p_attr_name => $3,
                p_value_timestamp => $4::timestamptz,
                p_value_range     => $5::tstzrange,
                p_value_numeric   => $6::numeric,
                p_value_text      => $7,
                p_value_jsonb     => $8::jsonb,
                p_unit            => $9,
                p_provenance      => $10,
                p_confidence      => $11::numeric,
                p_valid_from      => $12::timestamptz,
                p_valid_to        => $13::timestamptz,
                p_metadata_jsonb  => $14::jsonb,
                p_ref_source      => $15, p_ref_entity => $16, p_ref_key => $17
            ) AS id`,
    [targetKind, targetId, attrName, valueTimestamp, valueRange, valueNumeric, valueText, valueJsonb, unit, provenance, confidence, validFrom, validTo, metadata, refSource, refEntity, refKey],
  );

  const attr = await dbOne(
    ctx,
    `SELECT ${svporAttributeCols()} FROM maludb_svpor_attribute WHERE attribute_id = $1`,
    [Number(row?.id)],
  );
  if (attr === null) jsonError('internal_error', 'Attribute vanished after creation.', 500);
  shapeAttribute(attr);
  return attr;
}

/**
 * For a list endpoint called with ?with=attributes: attach an `attributes` value to each row from
 * the given `maludb_*_with_attributes` view, matched on `pkCol = row.id`. One extra query inside
 * `dbTxCore()` (the `*_with_attributes` views resolve their malu$* tables there). `view`/`pkCol` are
 * endpoint constants (never user input). Mutates `rows` in place.
 */
export async function attachAttributes(
  ctx: RequestCtx,
  rows: Row[],
  view: string,
  pkCol: string,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const attrs = await dbTxCore(ctx, () =>
    dbMany(
      ctx,
      `SELECT ${pkCol} AS id, attributes FROM ${view} WHERE ${pkCol} IN (${placeholders})`,
      ids,
    ),
  );
  const byId = new Map<number, unknown>();
  for (const a of attrs) byId.set(Number(a.id), a.attributes ?? null);
  for (const r of rows) r.attributes = byId.get(Number(r.id)) ?? null;
}
