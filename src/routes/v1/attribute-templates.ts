/**
 * GET  /v1/attribute-templates
 * POST /v1/attribute-templates
 *
 * MaluDB concept: the typed-property form catalog (maludb_core 0.83.0+).
 * SQL objects: maludb_attribute_template (writable view) + maludb_attribute_template_create (facade).
 * Teaches:
 *   - The catalog drives forms: which attributes apply to a given node/edge type, their value_type,
 *     requirement, label, unit, etc.
 *     applies_to  ∈ (episode_type, document_type, subject_type, verb)
 *     value_type  ∈ (timestamp, tstzrange, numeric, text, jsonb, reference)
 *     requirement ∈ (required, recommended, optional)
 *   - Bad enum values raise a DB check/trigger → 422 via the global handler.
 *   - No PATCH (the 0.83.0 surface exposes only create + delete; re-create to change).
 * Runs in dbTxCore() so the facade resolves its malu$* base tables.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { jsonResponse } from '../../http/response.js';
import { jsonError } from '../../http/errors.js';
import { queryInt, queryStr, bodyObject } from '../../http/request.js';
import type { Row } from '../../types/db.js';

const FILE = 'attribute-templates.ts';

/** Normalize scalar types on a template row in place (jsonb is already parsed by node-pg). */
export function shapeTemplate(r: Row): void {
  r.id = Number(r.id);
  r.display_order = r.display_order === null ? null : Number(r.display_order);
  if (r.allowed_values === undefined) r.allowed_values = null;
  if (r.default_value === undefined) r.default_value = null;
}

/** Read-side column list for a maludb_attribute_template row. */
export function templateCols(): string {
  return `template_id AS id, applies_to, type_value, attr_name, value_type, requirement,
          label, description, unit, allowed_values, default_value, display_order, created_at`;
}

export async function register(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/attribute-templates',
    handler: async (request, reply) => {
      const ctx = await requireAuth(request, FILE);

      switch (request.method) {
        case 'GET': {
          const appliesTo = queryStr(request, 'applies_to', null, 40);
          const typeValue = queryStr(request, 'type_value', null, 200);
          const limit = queryInt(request, 'limit', 200, 500) ?? 200;

          const clauses: string[] = [];
          const params: unknown[] = [];
          if (appliesTo !== null && appliesTo !== '') { params.push(appliesTo); clauses.push(`applies_to = $${params.length}`); }
          if (typeValue !== null && typeValue !== '') { params.push(typeValue); clauses.push(`type_value = $${params.length}`); }
          const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

          const rows = await dbTxCore(ctx, () =>
            dbMany(
              ctx,
              `SELECT ${templateCols()}
                 FROM maludb_attribute_template
                 ${where}
                ORDER BY applies_to, type_value, display_order NULLS LAST, attr_name
                LIMIT ${limit}`,
              params,
            ),
          );
          for (const r of rows) shapeTemplate(r);

          jsonResponse(reply, { attribute_templates: rows }, 200, ctx);
          return;
        }

        case 'POST': {
          const body = bodyObject(request);

          const appliesTo = String(body.applies_to ?? '').trim();
          const typeValue = String(body.type_value ?? '').trim();
          const attrName = String(body.attr_name ?? '').trim();
          const valueType = String(body.value_type ?? '').trim();
          for (const [name, val] of Object.entries({
            applies_to: appliesTo,
            type_value: typeValue,
            attr_name: attrName,
            value_type: valueType,
          })) {
            if (val === '') jsonError('missing_field', `Field "${name}" is required.`, 400);
          }

          const requirement =
            body.requirement !== undefined && String(body.requirement).trim() !== ''
              ? String(body.requirement)
              : 'optional';
          const label = body.label !== undefined ? String(body.label) : null;
          const description = body.description !== undefined ? String(body.description) : null;
          const unit = body.unit !== undefined ? String(body.unit) : null;
          const allowed =
            Object.prototype.hasOwnProperty.call(body, 'allowed_values') && body.allowed_values !== null
              ? JSON.stringify(body.allowed_values)
              : null;
          const defaultValue =
            Object.prototype.hasOwnProperty.call(body, 'default_value') && body.default_value !== null
              ? JSON.stringify(body.default_value)
              : null;
          let displayOrder: number | null = null;
          if (Object.prototype.hasOwnProperty.call(body, 'display_order') && body.display_order !== null) {
            if (!Number.isInteger(body.display_order)) {
              jsonError('validation_failed', '"display_order" must be an integer.', 422);
            }
            displayOrder = Number(body.display_order);
          }

          const created = await dbTxCore(ctx, async () => {
            const row = await dbOne(
              ctx,
              `SELECT maludb_attribute_template_create(
                          p_applies_to    => $1, p_type_value => $2, p_attr_name => $3, p_value_type => $4,
                          p_requirement   => $5, p_label => $6, p_description => $7, p_unit => $8,
                          p_allowed_values => $9::jsonb, p_default_value => $10::jsonb, p_display_order => $11
                      ) AS id`,
              [appliesTo, typeValue, attrName, valueType, requirement, label, description, unit, allowed, defaultValue, displayOrder],
            );
            const t = await dbOne(
              ctx,
              `SELECT ${templateCols()} FROM maludb_attribute_template WHERE template_id = $1`,
              [Number(row?.id)],
            );
            if (t === null) jsonError('internal_error', 'Attribute template vanished after creation.', 500);
            shapeTemplate(t);
            return t;
          });

          jsonResponse(reply, { attribute_template: created }, 201, ctx);
          return;
        }
      }
    },
  });
}
