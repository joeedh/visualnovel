/**
 * The version the app reports about itself.
 *
 * `apps/desktop/package.json` is the source of truth (the root and `packages/*` are private and
 * unpublished, so versioning them buys nothing), and a tag is asserted against it rather than
 * written by CI. A build made between releases carries the commit as well, so a bug report from
 * someone running one says which build it was rather than naming a version that shipped twice.
 */
import { execFile } from 'node:child_process';

/** How a version is written down. Pure, because the wording decision lives here. */
export function describeVersion(version: string, at: { packaged: boolean; sha?: string }): string {
  if (at.packaged) return version;
  return at.sha ? `${version} (dev ${at.sha})` : `${version} (dev)`;
}

/**
 * The short sha of the checkout the app is being run from, or undefined outside one. Only ever
 * asked in a development build — a packaged app has no repository to ask.
 */
export function shortSha(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, windowsHide: true }, (err, stdout) => {
      const sha = stdout.toString().trim();
      resolve(err || sha.length === 0 ? undefined : sha);
    });
  });
}
