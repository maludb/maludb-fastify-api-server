/**
 * SVO statement helpers (maludb_core) — shared by `statements.ts` and `episodes_id_statements.ts`.
 * A statement is `(subject_kind, subject_id) --verb_id--> (object_kind, object_id)`, created via the
 * idempotent `maludb_svpor_statement_create(...)` facade. Both call `svporCreateStatement()` inside
 * `dbTxCore()` (the verb/subject/predicate resolvers and the facade need `maludb_core` on the
 * search path). Ported verbatim from the PHP `config/response.php`.
 */
import { dbOne } from './query.js';
import { isNumeric, toNumOrNull } from './coerce.js';
import { jsonError } from '../http/errors.js';
import type { RequestCtx, Row } from '../types/db.js';

/** Read-side column list for a maludb_svpor_statement row. */
export function svporStatementCols(): string {
  return `statement_id AS id, subject_kind, subject_id, verb_id, object_kind, object_id,
          predicate_id, valid_from, valid_to, confidence, provenance, source_package_id,
          metadata_jsonb AS metadata, created_at`;
}

/** Normalize scalar types on a statement row in place (jsonb is already parsed by node-pg). */
export function shapeStatement(r: Row): void {
  for (const k of ['id', 'subject_id', 'verb_id', 'object_id', 'predicate_id', 'source_package_id']) {
    r[k] = toNumOrNull(r[k]);
  }
  r.confidence = toNumOrNull(r.confidence);
  if (r.metadata === undefined) r.metadata = null;
}

export interface ForceObject {
  kind: string;
  id: number;
}

/**
 * Create a statement from a request body and return the created (shaped) row. MUST run inside
 * `dbTxCore()`. All shape/required-field checks run before any DB write, so a rejected request
 * never leaves a half-resolved person behind. `forceObject` overrides object_kind/object_id
 * (episode-scoped route).
 */
export async function svporCreateStatement(
  ctx: RequestCtx,
  body: Record<string, unknown>,
  forceObject: ForceObject | null = null,
): Promise<Row> {
  // ---- phase 1: parse + shape-validate (no DB writes) ----
  let verbId: number | null = null;
  let verbName: string | null = null;
  if (body.verb_id !== undefined) {
    if (!Number.isInteger(body.verb_id)) jsonError('validation_failed', '"verb_id" must be an integer.', 422);
    verbId = body.verb_id as number;
  } else if (body.verb !== undefined && String(body.verb).trim() !== '') {
    verbName = String(body.verb);
  } else {
    jsonError('missing_field', 'Provide "verb" (name) or "verb_id".', 400);
  }

  const subjectKind =
    body.subject_kind !== undefined && String(body.subject_kind).trim() !== ''
      ? String(body.subject_kind)
      : 'subject';
  let subjectId: number | null = null;
  let subjectName: string | null = null;
  if (body.subject_id !== undefined) {
    if (!Number.isInteger(body.subject_id)) jsonError('validation_failed', '"subject_id" must be an integer.', 422);
    subjectId = body.subject_id as number;
  } else if (subjectKind === 'subject' && body.subject !== undefined && String(body.subject).trim() !== '') {
    subjectName = String(body.subject);
  } else {
    jsonError('missing_field', 'Provide "subject_id", or "subject" (name) when subject_kind is "subject".', 400);
  }

  let objectKind: string;
  let objectId: number;
  if (forceObject !== null) {
    objectKind = String(forceObject.kind);
    objectId = Number(forceObject.id);
  } else {
    objectKind = body.object_kind !== undefined ? String(body.object_kind).trim() : '';
    if (objectKind === '') jsonError('missing_field', 'Field "object_kind" is required.', 400);
    if (body.object_id === undefined || !Number.isInteger(body.object_id)) {
      jsonError('validation_failed', '"object_id" must be an integer.', 422);
    }
    objectId = body.object_id as number;
  }

  let predicateId: number | null = null;
  let predicateName: string | null = null;
  if (body.predicate_id !== undefined) {
    if (!Number.isInteger(body.predicate_id)) jsonError('validation_failed', '"predicate_id" must be an integer.', 422);
    predicateId = body.predicate_id as number;
  } else if (body.predicate !== undefined && String(body.predicate).trim() !== '') {
    predicateName = String(body.predicate);
  }
  if ('confidence' in body && body.confidence !== null && !isNumeric(body.confidence)) {
    jsonError('validation_failed', '"confidence" must be a number.', 422);
  }

  const validFrom = body.valid_from !== undefined ? String(body.valid_from) : null;
  const validTo = body.valid_to !== undefined ? String(body.valid_to) : null;
  const confidence =
    'confidence' in body && body.confidence !== null ? String(body.confidence) : null;
  const provenance =
    body.provenance !== undefined && String(body.provenance).trim() !== ''
      ? String(body.provenance)
      : 'provided';
  const sourcePkg =
    body.source_package_id !== undefined && body.source_package_id !== null
      ? Number(body.source_package_id)
      : null;
  const metadata =
    body.metadata !== undefined && body.metadata !== null && typeof body.metadata === 'object'
      ? JSON.stringify(body.metadata)
      : '{}';

  // ---- phase 2: resolve names (SELECTs), then upsert the subject, then create ----
  if (verbId === null) {
    const r = await dbOne(ctx, 'SELECT maludb_core.resolve_svpor_verb($1) AS id', [verbName]);
    if (r === null || r.id === null) jsonError('validation_failed', `Unknown verb "${verbName}".`, 422);
    verbId = Number(r.id);
  }
  if (predicateName !== null) {
    const r = await dbOne(ctx, 'SELECT maludb_core.resolve_svpor_predicate($1) AS id', [predicateName]);
    if (r === null || r.id === null) jsonError('validation_failed', `Unknown predicate "${predicateName}".`, 422);
    predicateId = Number(r.id);
  }
  if (subjectId === null) {
    const r = await dbOne(
      ctx,
      "SELECT register_svpor_subject(p_canonical_name => $1, p_subject_type => 'person') AS id",
      [subjectName],
    );
    subjectId = Number(r?.id);
  }

  const created = await dbOne(
    ctx,
    `SELECT maludb_svpor_statement_create(
                p_subject_kind      => $1, p_subject_id => $2,
                p_verb_id           => $3,
                p_object_kind       => $4, p_object_id  => $5,
                p_predicate_id      => $6,
                p_valid_from        => $7::timestamptz, p_valid_to => $8::timestamptz,
                p_confidence        => $9::numeric,
                p_provenance        => $10,
                p_source_package_id => $11,
                p_metadata_jsonb    => $12::jsonb
            ) AS id`,
    [subjectKind, subjectId, verbId, objectKind, objectId, predicateId, validFrom, validTo, confidence, provenance, sourcePkg, metadata],
  );

  const stmt = await dbOne(
    ctx,
    `SELECT ${svporStatementCols()} FROM maludb_svpor_statement WHERE statement_id = $1`,
    [Number(created?.id)],
  );
  if (stmt === null) jsonError('internal_error', 'Statement vanished after creation.', 500);
  shapeStatement(stmt);
  return stmt;
}
