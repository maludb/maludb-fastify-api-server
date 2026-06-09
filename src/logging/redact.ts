/**
 * Secret redaction for the SQL log. Some memory-pipeline writes bind a plaintext model token as a
 * parameter; those go through `dbOneRedacted`, which replaces the secret-bearing positions with
 * `<redacted>` before the params reach `sql.log`. Never log full tokens or plaintext passwords.
 */

/** Return a copy of `params` with the given 1-based positions replaced by `<redacted>`. */
export function redactParams(params: unknown[], redact1Based: number[]): unknown[] {
  const out = params.slice();
  for (const i of redact1Based) {
    const idx = i - 1;
    if (idx >= 0 && idx < out.length) out[idx] = '<redacted>';
  }
  return out;
}
