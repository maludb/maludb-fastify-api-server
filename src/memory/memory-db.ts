/**
 * DB-facing glue for the memory pipeline (the bits of the PHP `config/response.php` memory section
 * that touch Postgres): render a malu_vector SQL literal, and resolve a stored secret to its
 * plaintext token (with an env fallback). Kept separate from `llm.ts` (the outbound model calls).
 */
import { dbOne } from '../db/query.js';
import { dbTxCore } from '../db/tx.js';
import type { RequestCtx } from '../types/db.js';

/** Render a float array as a malu_vector literal body, e.g. "[0.1,-0.2,...]". Cast in SQL. */
export function memVectorLiteral(floats: number[]): string {
  const parts = floats.map((f) => {
    const s = f.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' || s === '-' ? '0' : s;
  });
  return `[${parts.join(',')}]`;
}

/** Resolve a stored secret to its plaintext (needs maludb_secret_consumer); env fallback. */
export async function memResolveToken(
  ctx: RequestCtx,
  secretRef: string | null,
): Promise<string | null> {
  if (secretRef !== null && secretRef !== '') {
    try {
      const row = await dbTxCore(ctx, () =>
        dbOne(ctx, 'SELECT maludb_core.__secret_resolve($1) AS tok', [secretRef]),
      );
      if (row !== null && row.tok !== null && row.tok !== '') return String(row.tok);
    } catch {
      // No maludb_secret_consumer grant (or secret missing) → fall through to env.
    }
  }
  const env = process.env.MALUDB_LLM_TOKEN;
  return env !== undefined && env !== '' ? env : null;
}
