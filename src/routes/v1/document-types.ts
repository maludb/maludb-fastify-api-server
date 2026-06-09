/**
 * GET  /v1/document-types
 * POST /v1/document-types
 *
 * MaluDB concept: Document-type picker list (maludb_core 0.81.0) — feeds the
 * type dropdown.
 * SQL objects: maludb_document_type (writable per-schema view; document_type_id
 * from sequence).
 * Teaches:
 *   - The label is case-insensitive unique (lower(document_type)) — a duplicate
 *     raises 23505, mapped to 409 by the global handler.
 *   - The list is advisory only: maludb_document.document_type is free text with
 *     no FK here, so a document may carry a type that isn't in this list.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { bodyObject } from '../../http/request.js';

const FILE = 'document-types.ts';

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/document-types',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const rows = await dbMany(
          ctx,
          `SELECT document_type_id AS id,
                  document_type,
                  description,
                  display_order,
                  created_at
             FROM maludb_document_type
            ORDER BY display_order NULLS LAST, document_type`,
        );
        for (const r of rows) {
          r.id = Number(r.id);
          r.display_order = r.display_order === null ? null : Number(r.display_order);
        }

        jsonResponse(reply, { document_types: rows }, 200, ctx);
        return;
      }

      // POST
      const body = bodyObject(request);

      const label = String(body.document_type ?? '').trim();
      if (label === '') {
        jsonError('missing_field', 'Field "document_type" is required.', 400);
      }
      const description = body.description !== undefined ? String(body.description) : null;
      let displayOrder: number | null = null;
      if (
        Object.prototype.hasOwnProperty.call(body, 'display_order') &&
        body.display_order !== null
      ) {
        if (!Number.isInteger(body.display_order)) {
          jsonError('validation_failed', '"display_order" must be an integer.', 422);
        }
        displayOrder = Number(body.display_order);
      }

      const created = await dbOne(
        ctx,
        `INSERT INTO maludb_document_type (document_type, description, display_order)
         VALUES ($1, $2, $3)
         RETURNING document_type_id AS id, document_type, description, display_order, created_at`,
        [label, description, displayOrder],
      );
      if (created === null) {
        jsonError('internal_error', 'Document type creation returned no row.', 500);
      }
      created.id = Number(created.id);
      created.display_order = created.display_order === null ? null : Number(created.display_order);

      jsonResponse(reply, { document_type: created }, 201, ctx);
    },
  });
}
