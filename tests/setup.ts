/**
 * Vitest global setup. Redirect the config DB and logs into a throwaway temp dir so the unit suite
 * never touches the real `~/.maludb` and leaves nothing behind.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'maludb-test-'));
process.env.MALUDB_HOME = dir;
process.env.MALUDB_LOG_DIR = join(dir, 'logs');
process.env.MALUDB_CONFIG_DB = join(dir, 'config.sqlite');
