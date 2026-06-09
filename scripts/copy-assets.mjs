// Copy non-TS runtime assets into dist/ after `tsc`. The local-db schema is kept as a
// readable .sql file (not embedded as a string), so it must be copied next to the compiled
// local-db.js, which resolves it relative to its own location.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const assets = [['src/local-db/schema.sql', 'dist/local-db/schema.sql']];

for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
