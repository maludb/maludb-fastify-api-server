#!/usr/bin/env node
/**
 * `maludb-api-server` CLI (brief §5.2). Initializes the local SQLite config DB, runs (idempotent)
 * migrations, starts the API server, and manages API tokens. Kept deliberately small — it shells
 * out to the same local-db accessors the server uses.
 *
 *   maludb-api-server init
 *   maludb-api-server migrate
 *   maludb-api-server start
 *   maludb-api-server token create --db <db> --user <u> --password <p> [--role r] [--expires-days N] [--device name]
 *   maludb-api-server token list   --db <db> --user <u>
 *   maludb-api-server token revoke <id> --db <db> --user <u>
 */
import { pathToFileURL } from 'node:url';
import { applyMigrations, openLocalDb } from './local-db/local-db.js';
import { configDbPath } from './config/paths.js';
import { runTokenCommand } from './local-db/token-cli.js';

function out(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function printHelp(): void {
  out(
    [
      'maludb-api-server <command>',
      '',
      'Commands:',
      '  init                 Create the local SQLite config DB and apply the schema',
      '  migrate              Re-apply the schema (idempotent)',
      '  start                Start the API server',
      '  token create ...     Mint an API token for a Postgres connection',
      '  token list ...       List tokens for a Postgres connection',
      '  token revoke <id>    Revoke a token',
      '',
      `Config DB: ${configDbPath()}`,
    ].join('\n'),
  );
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      openLocalDb().close();
      out(`Initialized config DB at ${configDbPath()}`);
      return 0;
    }
    case 'migrate': {
      applyMigrations();
      out(`Migrations applied to ${configDbPath()}`);
      return 0;
    }
    case 'start': {
      await import('./server.js');
      return 0;
    }
    case 'token': {
      return runTokenCommand(rest);
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      return 0;
    }
    default: {
      out(`Unknown command: ${cmd}`);
      printHelp();
      return 1;
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
