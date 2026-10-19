/**
 * The claims ledger: `assets/claims/<hash>/<project_id>`, one empty file per project that uses a
 * base picture it may not have made. Two projects claiming at once add different files, so a
 * rebase pull cannot conflict on them. The collector keeps a picture another project claims.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists, writeFileAtomic } from '@vn/util';
import type { ProjectPaths } from './paths.js';

/** Reads every claim in the ledger, as the projects claiming each hash. */
export async function readClaims(paths: ProjectPaths): Promise<Map<string, Set<string>>> {
  const claims = new Map<string, Set<string>>();
  const hashes = await readdir(paths.claimsDir).catch(() => [] as string[]);
  for (const hash of hashes) {
    const ids = await readdir(join(paths.claimsDir, hash)).catch(() => [] as string[]);
    if (ids.length > 0) claims.set(hash, new Set(ids));
  }
  return claims;
}

/** Finds the hashes some project other than `own` claims; with no `own`, every claimed hash. */
export function claimedByOthers(
  claims: ReadonlyMap<string, ReadonlySet<string>>,
  own: string | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const [hash, ids] of claims) {
    if ([...ids].some((id) => id !== own)) out.add(hash);
  }
  return out;
}

/** Records `projectId`'s claim on `hash`, answering the file it wrote. */
export async function addClaim(
  paths: ProjectPaths,
  hash: string,
  projectId: string,
): Promise<string> {
  const file = paths.claimFile(hash, projectId);
  await writeFileAtomic(file, '');
  return file;
}

/**
 * Drops `projectId`'s claim on `hash`, and the hash's folder once no claim is left in it. Answers
 * the file it removed, or undefined when there was no such claim.
 */
export async function removeClaim(
  paths: ProjectPaths,
  hash: string,
  projectId: string,
): Promise<string | undefined> {
  const file = paths.claimFile(hash, projectId);
  if (!(await exists(file))) return undefined;
  await rm(file, { force: true });
  await rmdir(dirname(file)).catch(() => {});
  return file;
}
