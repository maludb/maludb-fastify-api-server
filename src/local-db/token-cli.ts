/**
 * CLI token management (`maludb-api-server token …`). Stub until the Postgres credential test is
 * wired in Phase 4 (`db/tenant.ts#testCredentials`) — token create/list/revoke authorize the same
 * way the `/v1/tokens` endpoint does, by proving the supplied Postgres login works. Replaced with
 * the full implementation in Phase 4.3.
 */
export async function runTokenCommand(_args: string[]): Promise<number> {
  // eslint-disable-next-line no-console
  console.error('`token` commands are wired in Phase 4 (Postgres credential test). Not yet available.');
  return 1;
}
