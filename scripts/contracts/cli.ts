/**
 * What `pnpm contracts <query> [--full]` bundles and runs. A query with a subject prefix
 * (`module:`, `command:`, …) is a subject lookup, one that is a contract's id is that contract,
 * and anything else is a text search.
 */
import { answer, byId, EMPTY_QUERY, isSubject } from '@vn/contracts/query';

/** The text to print for `argv`. */
export function run(argv: readonly string[]): string {
  const full = argv.includes('--full');
  const asked = argv
    .filter((a) => a !== '--full')
    .join(' ')
    .trim();
  if (!asked) return `Usage: pnpm contracts <subject | id | text> [--full]\n${EMPTY_QUERY}`;
  if (isSubject(asked)) return answer({ subject: asked, full }).output;
  if (byId(asked)) return answer({ id: asked, full }).output;
  return answer({ text: asked, full }).output;
}
