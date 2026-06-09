/**
 * PATCH  /v1/document-types/{id}
 * DELETE /v1/document-types/{id}
 *
 * MaluDB concept: Document-type picker entry (maludb_core 0.81.0).
 * SQL objects: maludb_document_type (writable per-schema view).
 * Teaches:
 *   - The label is case-insensitive unique (lower(document_type)) — a colliding
 *     update raises 23505, mapped to 409 by the global handler.
 *   - Deleting a type does NOT affect documents already tagged with that string:
 *     maludb_document.document_type is free text with no FK to this list.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbOne, dbExec } from '../../db/query.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { pathId, bodyObject } from '../../http/request.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'document-types_id.ts';

async function loadDocumentType(ctx: RequestCtx, id: number): Promise<Row | null> {
  const row = await dbOne(
    ctx,
    `SELECT document_type_id AS id, document_type, description, display_order, created_at
       FROM maludb_document_type
      WHERE document_type_id = $1`,
    [id],
  );
  if (row === null) {
    return null;
  }
  row.id = Number(row.id);
  row.display_order = row.display_order === null ? null : Number(row.display_order);
  return row;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['PATCH', 'DELETE'],
    url: '/v1/document-types/:id',
    handler: async (request: FastifyRequest, reply) => {
      const ctx = await requireAuth(request, FILE);
      const id = pathId(request);

      if (request.method === 'PATCH') {
        if (
          (await dbOne(ctx, 'SELECT 1 FROM maludb_document_type WHERE document_type_id = $1', [
            id,
          ])) === null
        ) {
          jsonError('not_found', 'Document type not found.', 404);
        }

        const body = bodyObject(request);
        const fields: string[] = [];
        const params: unknown[] = [];

        if (Object.prototype.hasOwnProperty.call(body, 'document_type')) {
          const label = String(body.document_type ?? '').trim();
          if (label === '') {
            jsonError('validation_failed', 'Field "document_type" cannot be empty.', 422);
          }
          params.push(label);
          fields.push(`document_type = $${params.length}`);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'description')) {
          params.push(body.description === null ? null : String(body.description));
          fields.push(`description = $${params.length}`);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
          if (body.display_order !== null && !Number.isInteger(body.display_order)) {
            jsonError('validation_failed', '"display_order" must be an integer.', 422);
          }
          params.push(body.display_order === null ? null : Number(body.display_order));
          fields.push(`display_order = $${params.length}`);
        }
        if (fields.length === 0) {
          jsonError(
            'bad_request',
            'No updatable fields provided (document_type, description, display_order).',
            400,
          );
        }

        params.push(id);
        await dbExec(
          ctx,
          `UPDATE maludb_document_type SET ${fields.join(', ')} WHERE document_type_id = $${params.length}`,
          params,
        );

        jsonResponse(reply, { document_type: await loadDocumentType(ctx, id) }, 200, ctx);
        return;
      }

      // DELETE
      const n = await dbExec(ctx, 'DELETE FROM maludb_document_type WHERE document_type_id = $1', [
        id,
      ]);
      if (n === 0) {
        jsonError('not_found', 'Document type not found.', 404);
      }
      jsonResponse(reply, { deleted: true, id }, 200, ctx);
    },
  });
}
