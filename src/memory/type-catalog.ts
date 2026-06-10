/**
 * Subject-type catalog rendering (0.96.0). The extraction prompts carry {{ENTITY_TYPES}} /
 * {{EVENT_KINDS}} placeholders; this renders the entity/event vocabularies straight from the
 * tenant catalog so the prompt's allowed types can never drift from what the ingest accepts.
 *
 * The maludb_subject_type facade exposes `category` once a tenant has re-run
 * enable_memory_schema(); until then we fall back to the maludb_core base table, which carries
 * `category` immediately after the 0.96.0 extension upgrade.
 *
 * Shared by /v1/memory/ingest and /v1/skills/ingest.
 */
import { dbMany } from '../db/query.js';
import type { RequestCtx } from '../types/db.js';

export interface TypeCatalog {
  /** Bullet list of entity types for {{ENTITY_TYPES}} (falls back to `  - other`). */
  entityBlock: string;
  /** Bullet list of event kinds for {{EVENT_KINDS}} (falls back to `  - task`). */
  eventBlock: string;
  entityCount: number;
  eventCount: number;
}

/** Render the entity-type and event-kind bullet lists from the live catalog. */
export async function renderTypeCatalog(ctx: RequestCtx): Promise<TypeCatalog> {
  let typeRows;
  try {
    typeRows = await dbMany(
      ctx,
      'SELECT category, subject_type, description FROM maludb_subject_type ORDER BY category, sort_order',
    );
  } catch {
    // single-quoted on purpose: the `$` in malu$svpor_* must not be parsed as a variable
    typeRows = await dbMany(
      ctx,
      'SELECT category, subject_type, description FROM maludb_core.malu$svpor_subject_type ORDER BY category, sort_order',
    );
  }
  const entityLines: string[] = [];
  const eventLines: string[] = [];
  for (const r of typeRows) {
    const desc =
      r.description !== undefined && String(r.description ?? '').trim() !== ''
        ? ' — ' + String(r.description)
        : '';
    const line = '  - ' + String(r.subject_type) + desc;
    if ((r.category ?? 'entity') === 'event') {
      eventLines.push(line);
    } else {
      entityLines.push(line);
    }
  }
  return {
    // Fallbacks keep the model inside the catalog even if a list comes back empty.
    entityBlock: entityLines.length !== 0 ? entityLines.join('\n') : '  - other',
    eventBlock: eventLines.length !== 0 ? eventLines.join('\n') : '  - task',
    entityCount: entityLines.length,
    eventCount: eventLines.length,
  };
}
