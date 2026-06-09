/**
 * Document ↔ graph helpers (maludb_core) — documents are first-class graph nodes. A
 * project/subject/stakeholder tag on a document is mirrored as a real edge
 * `(document) --concerns|mentions|involves--> (subject)` plus the resolved id on the soft tag row,
 * exactly as `maludb_upload_document` does. All three helpers MUST run inside `dbTxCore()`. Ported
 * verbatim from the PHP `config/response.php`.
 */
import { dbExec, dbMany, dbOne } from './query.js';
import { jsonError } from '../http/errors.js';
import type { RequestCtx } from '../types/db.js';

/** Document tag_kind → [subject_type, verb] for the three subject-like kinds; null otherwise. */
export function documentLinkSpec(tagKind: string): [string, string] | null {
  const map: Record<string, [string, string]> = {
    project: ['project', 'concerns'],
    subject: ['concept', 'mentions'],
    stakeholder: ['person', 'involves'],
  };
  return map[tagKind] ?? null;
}

/**
 * Link a document to a project/subject/stakeholder by name (idempotent): resolve-or-create the
 * subject WITHOUT clobbering an existing subject's type, create the document→subject edge, and
 * record the resolved id on the soft tag row. Returns the subject_id (null for a blank name).
 */
export async function documentLinkSubject(
  ctx: RequestCtx,
  documentId: number,
  tagKind: string,
  rawName: string,
  provenance = 'provided',
): Promise<number | null> {
  const name = rawName.trim();
  if (name === '') return null;
  const spec = documentLinkSpec(tagKind);
  if (spec === null) jsonError('validation_failed', `Unsupported document link kind "${tagKind}".`, 422);
  const [subjectType, verb] = spec;

  // Resolve-or-create the subject. Reuse an existing one as-is (never override its type).
  const existing = await dbOne(ctx, 'SELECT subject_id FROM maludb_subject WHERE canonical_name = $1', [name]);
  const subjectId =
    existing !== null
      ? Number(existing.subject_id)
      : Number(
          (
            await dbOne(
              ctx,
              'SELECT register_svpor_subject(p_canonical_name => $1, p_subject_type => $2) AS id',
              [name, subjectType],
            )
          )?.id,
        );

  const verbId = Number(
    (await dbOne(ctx, 'SELECT maludb_core.resolve_svpor_verb($1) AS id', [verb]))?.id,
  );

  await dbOne(
    ctx,
    `SELECT maludb_svpor_statement_create(
                p_subject_kind => 'document', p_subject_id => $1,
                p_verb_id      => $2,
                p_object_kind  => 'subject',  p_object_id  => $3,
                p_provenance   => $4) AS id`,
    [documentId, verbId, subjectId, provenance],
  );

  // The soft tag carries the resolved object so the UI can link to the real record.
  const tag = await dbOne(
    ctx,
    `SELECT tag_id FROM maludb_document_tag
      WHERE document_id = $1 AND tag_kind = $2 AND tag_value = $3 AND provenance = $4`,
    [documentId, tagKind, name, provenance],
  );
  if (tag === null) {
    await dbExec(
      ctx,
      `INSERT INTO maludb_document_tag (document_id, tag_kind, tag_value, tag_object_type, tag_object_id, provenance)
       VALUES ($1, $2, $3, 'subject', $4, $5)`,
      [documentId, tagKind, name, subjectId, provenance],
    );
  } else {
    await dbExec(
      ctx,
      "UPDATE maludb_document_tag SET tag_object_type = 'subject', tag_object_id = $1 WHERE tag_id = $2",
      [subjectId, Number(tag.tag_id)],
    );
  }
  return subjectId;
}

/**
 * Remove a document↔subject link by name: delete the edge, delete the soft tag row, and if the
 * subject was the document's primary project, repoint primary_project_id to the first remaining
 * project tag (else NULL). No-op when the link does not exist.
 */
export async function documentUnlinkSubject(
  ctx: RequestCtx,
  documentId: number,
  tagKind: string,
  rawName: string,
  provenance = 'provided',
): Promise<void> {
  const name = rawName.trim();
  if (name === '') return;
  const spec = documentLinkSpec(tagKind);
  if (spec === null) jsonError('validation_failed', `Unsupported document link kind "${tagKind}".`, 422);
  const [, verb] = spec;

  const row = await dbOne(ctx, 'SELECT subject_id FROM maludb_subject WHERE canonical_name = $1', [name]);
  if (row !== null) {
    const subjectId = Number(row.subject_id);
    const verbId = Number(
      (await dbOne(ctx, 'SELECT maludb_core.resolve_svpor_verb($1) AS id', [verb]))?.id,
    );
    const stmt = await dbOne(
      ctx,
      `SELECT statement_id FROM maludb_svpor_statement
        WHERE subject_kind = 'document' AND subject_id = $1
          AND object_kind  = 'subject'  AND object_id  = $2 AND verb_id = $3`,
      [documentId, subjectId, verbId],
    );
    if (stmt !== null) {
      await dbOne(ctx, 'SELECT maludb_svpor_statement_delete($1) AS d', [Number(stmt.statement_id)]);
    }
    // If this was the primary project, repoint to the first OTHER project tag (else NULL).
    await dbExec(
      ctx,
      `UPDATE maludb_document SET primary_project_id = (
           SELECT t.tag_object_id FROM maludb_document_tag t
            WHERE t.document_id = $1 AND t.tag_kind = 'project'
              AND t.tag_value <> $2 AND t.tag_object_id IS NOT NULL
            ORDER BY t.tag_id LIMIT 1)
        WHERE document_id = $3 AND primary_project_id = $4`,
      [documentId, name, documentId, subjectId],
    );
  }
  await dbExec(
    ctx,
    'DELETE FROM maludb_document_tag WHERE document_id = $1 AND tag_kind = $2 AND tag_value = $3 AND provenance = $4',
    [documentId, tagKind, name, provenance],
  );
}

/**
 * Documents linked to a subject/project through the unified graph (concerns/mentions/involves
 * edges). Returns [{id, title, rel}], one row per document (first rel kept). MUST run inside
 * `dbTxCore()`.
 */
export async function documentNeighbors(
  ctx: RequestCtx,
  subjectId: number,
): Promise<Array<{ id: number; title: unknown; rel: unknown }>> {
  const rows = await dbMany(
    ctx,
    `SELECT neighbor_id, label, rel
       FROM maludb_graph_neighbors('subject', $1, 'both', ARRAY['concerns','mentions','involves'])
      WHERE neighbor_kind = 'document'
      ORDER BY neighbor_id`,
    [subjectId],
  );
  const out: Array<{ id: number; title: unknown; rel: unknown }> = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const id = Number(r.neighbor_id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: r.label, rel: r.rel });
  }
  return out;
}
