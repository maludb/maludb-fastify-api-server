/**
 * GET  /v1/documents
 * POST /v1/documents   (multipart/form-data upload)
 *
 *   GET  ?q=&limit=   List documents (metadata + size + primary_project_id).
 *   POST              multipart/form-data upload. Parts: file, filename, mime_type, description,
 *                     document_type, projects, subjects (the last two comma-separated names).
 *
 * Bytes are stored in maludb_source_package.content_bytes (bytea); maludb_document holds
 * the metadata and links to the package. Both are direct-INSERT views; ids are sequence
 * assigned. Binary download is out of v1 (requirements §6) — GET returns metadata only.
 *
 * Documents are first-class graph nodes (maludb_core 0.87.0): each projects/subjects name is
 * wired into the unified graph (document→subject edge + soft tag) via documentLinkSubject(),
 * and primary_project_id is set from the first project. Reachable from the graph endpoints and
 * the project/subject detail pages thereafter.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne, dbExec } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { documentLinkSubject } from '../../db/documents.js';
import { attachAttributes } from '../../db/attributes.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr } from '../../http/request.js';

const FILE = 'documents.ts';

/** Parse a comma-separated name list, de-duplicate, preserve order, drop blanks. */
function parseNames(s: string | null | undefined): string[] {
  const out = new Map<string, string>();
  for (const raw of String(s ?? '').split(',')) {
    const n = raw.trim();
    if (n !== '') out.set(n, n);
  }
  return Array.from(out.values());
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/documents',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      if (request.method === 'GET') {
        const q = queryStr(request, 'q', null, 200);
        const limit = queryInt(request, 'limit', 50, 200) ?? 50;

        const params: unknown[] = [];
        let where = '';
        if (q !== null && q !== '') {
          params.push(`%${q}%`);
          where = 'WHERE d.title ILIKE $1';
        }
        params.push(limit);
        const limitIdx = params.length;

        const sql = `
          SELECT d.document_id              AS id,
                 d.title,
                 d.source_type,
                 d.media_type,
                 d.document_type,
                 d.primary_project_id,
                 d.metadata_jsonb->>'description' AS description,
                 sp.content_size,
                 d.created_at
            FROM maludb_document d
            LEFT JOIN maludb_source_package sp ON sp.source_package_id = d.source_package_id
            ${where}
           ORDER BY d.created_at DESC NULLS LAST, d.document_id DESC
           LIMIT $${limitIdx}`;

        const rows = await dbMany(ctx, sql, params);
        for (const r of rows) {
          r.id = Number(r.id);
          r.content_size = r.content_size === null ? null : Number(r.content_size);
          r.primary_project_id = r.primary_project_id === null ? null : Number(r.primary_project_id);
        }

        if (queryStr(request, 'with', null, 40) === 'attributes') {
          await attachAttributes(ctx, rows, 'maludb_document_with_attributes', 'document_id');
        }

        jsonResponse(reply, { documents: rows }, 200, ctx);
        return;
      }

      // POST — multipart/form-data (NOT JSON).
      const fields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let uploadFilename = '';
      let uploadMime = '';
      let sawFilePart = false;
      for await (const part of (request as any).parts()) {
        if (part.type === 'file') {
          sawFilePart = true;
          uploadFilename = part.filename ?? '';
          uploadMime = part.mimetype ?? '';
          try {
            fileBuffer = await part.toBuffer();
          } catch (e: any) {
            if (e?.code === 'FST_REQ_FILE_TOO_LARGE') {
              jsonError('upload_too_large', 'File exceeds the maximum allowed size.', 413);
            }
            throw e;
          }
        } else {
          fields[part.fieldname] = part.value as string;
        }
      }

      if (!sawFilePart || fileBuffer === null) {
        jsonError('missing_field', 'Missing "file" upload part (multipart/form-data).', 400);
      }
      const bytes = fileBuffer;

      const filename = String(fields.filename ?? uploadFilename ?? 'upload').trim() || 'upload';
      const mime = (String(fields.mime_type ?? uploadMime ?? '').trim() || 'application/octet-stream');
      const description =
        fields.description !== undefined ? String(fields.description) : null;
      // document_type (0.81.0): optional free-text picker label; advisory, no FK — any string is
      // allowed, omit/blank means NULL. Stored on the maludb_document view.
      const documentType =
        fields.document_type !== undefined && String(fields.document_type).trim() !== ''
          ? String(fields.document_type)
          : null;
      const size = bytes.length;
      const hash = createHash('sha256').update(bytes).digest('hex');

      // content_bytes (bytea): bind the Node Buffer directly — node-pg encodes bytea (replaces the
      // PHP PDO::PARAM_LOB binding).
      const spRow = await dbOne(
        ctx,
        `INSERT INTO maludb_source_package
             (source_type, content_bytes, media_type, content_size, content_hash, ingested_at)
         VALUES ('document', $1, $2, $3, $4, now()) RETURNING source_package_id`,
        [bytes, mime, size, hash],
      );
      const spid = Number(spRow?.source_package_id);

      const doc = await dbOne(
        ctx,
        `INSERT INTO maludb_document
             (source_package_id, title, source_type, media_type, document_type, metadata_jsonb, created_at)
         VALUES ($1, $2, 'document', $3, $4, $5, now())
         RETURNING document_id AS id, title, source_type, media_type, document_type, created_at`,
        [spid, filename, mime, documentType, JSON.stringify({ description, filename })],
      );
      if (doc === null) jsonError('internal_error', 'Document creation returned no row.', 500);
      doc.id = Number(doc.id);
      doc.description = description;
      doc.content_size = size;

      // Graph wiring (0.87.0): optional comma-separated projects/subjects → document→subject edges
      // + soft tags; primary_project_id from the first project. Done in one tx so the graph facades
      // resolve and partial links never persist.
      const projects = parseNames(fields.projects);
      const subjects = parseNames(fields.subjects);

      let primary: number | null = null;
      if (projects.length > 0 || subjects.length > 0) {
        primary = await dbTxCore(ctx, async () => {
          let first: number | null = null;
          for (const p of projects) {
            const sid = await documentLinkSubject(ctx, doc.id as number, 'project', p);
            if (first === null && sid !== null) first = sid;
          }
          for (const s of subjects) {
            await documentLinkSubject(ctx, doc.id as number, 'subject', s);
          }
          if (first !== null) {
            await dbExec(
              ctx,
              'UPDATE maludb_document SET primary_project_id = $1 WHERE document_id = $2 AND primary_project_id IS NULL',
              [first, doc.id],
            );
          }
          return first;
        });
      }
      doc.primary_project_id = primary;

      jsonResponse(reply, { document: doc }, 201, ctx);
    },
  });
}
