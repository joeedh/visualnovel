import { isAbsolute, join, relative, sep } from 'node:path';
import { userKeysDir, type VendorKeyStatus } from '@vn/config';

/**
 * Describes where a key came from, in words the pane can show. The four sources need
 * distinguishing because they mean different things: a key in the project is a fact about the
 * project, a key in the user directory is a fact about the machine, and an environment variable
 * is a fact about whatever shell launched the app — the source an author cannot see and the one
 * most likely to be stale.
 *
 * Pure, and it never touches the key value: `VendorKeyStatus` does not carry one.
 */
export function describeKeySource(projectDir: string, status: VendorKeyStatus | undefined): string {
  if (!status?.source) return 'Not set.';
  if (status.source.kind === 'env') return `From $${status.source.name}.`;
  const { dir, file } = status.source;
  if (dir === userKeysDir()) return `From ${join(dir, file)} — every project on this machine.`;
  const within = relative(projectDir, dir);
  if (!within.startsWith('..') && !isAbsolute(within)) {
    return `From ${join(within, file).split(sep).join('/')} in this project.`;
  }
  return `From ${join(dir, file)}.`;
}
