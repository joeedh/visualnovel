/**
 * Query the contract index from a shell: one summary line per match, or the full record with
 * `--full`. A query with a subject prefix (`module:packages/scriptedit/`) is a subject lookup, a
 * contract id is that contract, and anything else is a text search.
 *
 * Usage: `pnpm contracts <subject | id | text> [--full]`
 */
import { loadEntry } from './lib/load-entry.mjs';

process.stdout.write(
  (await loadEntry('scripts/contracts/cli.ts', 'run', process.argv.slice(2))) + '\n',
);
