/**
 * CLI token management (`maludb-api-server token …`). Authorizes exactly like the `/v1/tokens`
 * endpoint: it proves authorization by connecting to Postgres with the supplied credentials, then
 * operates on the local SQLite `users` store. The plaintext token is printed ONCE on create; only
 * its sha256 hash is stored.
 *
 *   token create --db <db> --user <u> --password <p> [--role r] [--expires-days N] [--device name] [--user-id N]
 *   token list   --db <db> --user <u> --password <p>
 *   token revoke <id> --db <db> --user <u> --password <p>
 */
import { createHash, randomBytes } from 'node:crypto';
import { deleteToken, getToken, insertToken, listTokens, nextUserId } from './local-db.js';
import { testCredentials } from '../db/tenant.js';
import type { TenantConfig } from '../types/db.js';

function err(msg: string): number {
  console.error(msg);
  return 1;
}

function out(msg: string): void {
  console.log(msg);
}

/** Minimal `--flag value` / `--flag=value` parser; also returns the leading positionals. */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        flags[a.slice(2)] = args[i + 1] ?? '';
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Pull + verify the Postgres connection triple (db/user/password) — proves authorization. */
async function authorize(flags: Record<string, string>): Promise<TenantConfig | number> {
  const tenant: TenantConfig = {
    dbname: (flags.db ?? '').trim(),
    user: (flags.user ?? '').trim(),
    password: flags.password ?? '',
  };
  if (tenant.dbname === '' || tenant.user === '' || tenant.password === '') {
    return err('Missing required --db, --user, --password.');
  }
  if (!(await testCredentials(tenant))) {
    return err('Could not connect to Postgres with the supplied credentials.');
  }
  return tenant;
}

export async function runTokenCommand(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const sub = positionals[0];

  switch (sub) {
    case 'create': {
      const tenant = await authorize(flags);
      if (typeof tenant === 'number') return tenant;

      const role = (flags.role ?? '').trim() || 'executor';
      const device = (flags.device ?? '').trim() || null;
      const userId =
        flags['user-id'] && /^\d+$/.test(flags['user-id'])
          ? Number.parseInt(flags['user-id'], 10)
          : nextUserId();

      let expiresAt: string | null = null;
      if (flags['expires-days']) {
        const days = Number.parseInt(flags['expires-days'], 10);
        if (!Number.isFinite(days) || days <= 0) return err('--expires-days must be a positive integer.');
        expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      }

      const body = randomBytes(32).toString('base64url');
      const token = `malu_${body}`;
      const hash = createHash('sha256').update(body).digest('hex');

      const id = insertToken({
        tokenHash: hash,
        tokenPrefix: body.slice(0, 8),
        userId,
        role,
        pgDbname: tenant.dbname,
        pgUser: tenant.user,
        pgPassword: tenant.password,
        expiresAt,
        deviceName: device,
      });

      out(`token   : ${token}   (shown once — store it now)`);
      out(`id      : ${id}`);
      out(`user_id : ${userId}`);
      out(`role    : ${role}`);
      out(`expires : ${expiresAt ?? 'never'}`);
      return 0;
    }

    case 'list': {
      const tenant = await authorize(flags);
      if (typeof tenant === 'number') return tenant;
      const rows = listTokens(tenant.dbname, tenant.user);
      out(JSON.stringify(rows, null, 2));
      return 0;
    }

    case 'revoke': {
      const idArg = positionals[1];
      if (!idArg || !/^\d+$/.test(idArg)) return err('Usage: token revoke <id> --db .. --user .. --password ..');
      const tenant = await authorize(flags);
      if (typeof tenant === 'number') return tenant;
      const id = Number.parseInt(idArg, 10);
      const row = getToken(id);
      if (row === null) return err(`No token with id ${id}.`);
      if (row.pg_dbname !== tenant.dbname || row.pg_user !== tenant.user) {
        return err('That token belongs to a different Postgres connection.');
      }
      deleteToken(id);
      out(`Revoked token ${id}.`);
      return 0;
    }

    default:
      return err('Usage: token <create|list|revoke> ...');
  }
}
