/**
 * GET    /v1/documents/:id
 * PATCH  /v1/documents/:id
 * DELETE /v1/documents/:id
 *
 *   GET     Document metadata + primary_project_id + tags[] (no binary; download is out of
 *           v1 — §6). Each tag carries its resolved tag_object_type/tag_object_id so the UI
 *           can link the tag to the real subject/project record.
 *   PATCH   Add/remove project & subject links, maintaining the graph (0.87.0). Body:
 *             { "link":   { "projects": ["X"], "subjects": ["Y"] },
 *               "unlink": { "projects": ["Z"], "subjects": ["W"] } }
 *   DELETE  Remove the document and its source package.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne, dbExec } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { documentLinkSubject, documentUnlinkSubject } from '../../db/documents.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx } from '../../types/db.js';

const FILE = 'documents_id.ts';

/** Document metadata + resolved tags[], or null if the document does not exist. */
async function loadDocumentDetail(ctx: RequestCtx, id: number): Promise<Record<string, unknown> | null> {
  const doc = await dbOne(
    ctx,
    `SELECT d.document_id              AS id,
            d.title,
            d.source_type,
            d.media_type,
            d.document_type,
            d.primary_project_id,
            d.metadata_jsonb->>'description' AS description,
            sp.content_size,
            sp.content_hash,
            d.created_at,
            d.updated_at
       FROM maludb_document d
       LEFT JOIN maludb_source_package sp ON sp.source_package_id = d.source_package_id
      WHERE d.document_id = $1`,
    [id],
  );
  if (doc === null) {
    return null;
  }
  doc.id = Number(doc.id);
  doc.content_size = doc.content_size === null ? null : Number(doc.content_size);
  doc.primary_project_id = doc.primary_project_id === null ? null : Number(doc.primary_project_id);

  // Soft tags now carry the resolved graph object (tag_object_type/tag_object_id).
  const tags = await dbMany(
    ctx,
    `SELECT tag_id, tag_kind, tag_value, tag_object_type, tag_object_id, provenance, confidence
       FROM maludb_document_tag
      WHERE document_id = $1
      ORDER BY tag_kind, tag_value, tag_id`,
    [id],
  );
  for (const t of tags) {
    t.tag_id = Number(t.tag_id);
    t.tag_object_id = t.tag_object_id === null ? null : Number(t.tag_object_id);
    t.confidence = t.confidence === null ? null : Number(t.confidence);
  }
  doc.tags = tags;

  return doc;
}

/** Pull a list of names for body[op][kind]; reject anything that is not a string array. */
function names(body: Record<string, unknown>, op: string, kind: string): string[] {
  const opObj = body[op];
  const list =
    opObj !== null && typeof opObj === 'object' && !Array.isArray(opObj)
      ? (opObj as Record<string, unknown>)[kind]
      : undefined;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    jsonError('validation_failed', `"${op}.${kind}" must be an array of names.`, 422);
  }
  const out = new Map<string, string>();
  for (const n of list) {
    if (typeof n !== 'string') {
      jsonError('validation_failed', `"${op}.${kind}" must contain only strings.`, 422);
    }
    const v = n.trim();
    if (v !== '') out.set(v, v);
  }
  return Array.from(out.values());
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'PATCH', 'DELETE'],
    url: '/v1/documents/:id',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      switch (request.method) {
        case 'GET': {
          const doc = await loadDocumentDetail(ctx, id);
          if (doc === null) {
            jsonError('not_found', 'Document not found.', 404);
          }
          jsonResponse(reply, { document: doc }, 200, ctx);
          return;
        }

        case 'PATCH': {
          if ((await dbOne(ctx, 'SELECT 1 FROM maludb_document WHERE document_id = $1', [id])) === null) {
            jsonError('not_found', 'Document not found.', 404);
          }

          const body = bodyObject(request);

          const linkProjects = names(body, 'link', 'projects');
          const linkSubjects = names(body, 'link', 'subjects');
          const unlinkProjects = names(body, 'unlink', 'projects');
          const unlinkSubjects = names(body, 'unlink', 'subjects');

          if (
            linkProjects.length === 0 &&
            linkSubjects.length === 0 &&
            unlinkProjects.length === 0 &&
            unlinkSubjects.length === 0
          ) {
            jsonError('bad_request', 'Provide link/unlink projects or subjects to change.', 400);
          }

          await dbTxCore(ctx, async () => {
            // Unlink first so a re-link in the same request re-establishes the edge cleanly.
            for (const p of unlinkProjects) await documentUnlinkSubject(ctx, id, 'project', p);
            for (const s of unlinkSubjects) await documentUnlinkSubject(ctx, id, 'subject', s);

            let first: number | null = null;
            for (const p of linkProjects) {
              const sid = await documentLinkSubject(ctx, id, 'project', p);
              if (first === null && sid !== null) first = sid;
            }
            for (const s of linkSubjects) await documentLinkSubject(ctx, id, 'subject', s);

            // Adopt a primary project when one isn't set yet (unlink may have just cleared it).
            if (first !== null) {
              await dbExec(
                ctx,
                'UPDATE maludb_document SET primary_project_id = $1 WHERE document_id = $2 AND primary_project_id IS NULL',
                [first, id],
              );
            }
          });

          jsonResponse(reply, { document: await loadDocumentDetail(ctx, id) }, 200, ctx);
          return;
        }

        case 'DELETE': {
          const row = await dbOne(
            ctx,
            'SELECT source_package_id FROM maludb_document WHERE document_id = $1',
            [id],
          );
          if (row === null) {
            jsonError('not_found', 'Document not found.', 404);
          }
          // Remove the document's graph edges first — deleting the document cascades its soft tags
          // but NOT its document→subject svpor_statement edges (0.87.0), which would otherwise
          // dangle. Done in a tx so the facade resolves under maludb_core.
          await dbTxCore(ctx, () =>
            dbExec(
              ctx,
              "DELETE FROM maludb_svpor_statement WHERE subject_kind = 'document' AND subject_id = $1",
              [id],
            ),
          );
          await dbExec(ctx, 'DELETE FROM maludb_document WHERE document_id = $1', [id]);
          if (row.source_package_id !== null) {
            await dbExec(
              ctx,
              'DELETE FROM maludb_source_package WHERE source_package_id = $1',
              [row.source_package_id],
            );
          }
          jsonResponse(reply, { deleted: true, id }, 200, ctx);
          return;
        }
      }
    },
  });
}
