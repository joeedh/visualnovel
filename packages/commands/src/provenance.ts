/**
 * Reading the command log back by commit. A record names the commits it made as they were made;
 * a later `git.pull` may have rebased those commits under new shas, and its own record carries
 * the table from old to new. The lookup here walks those tables backwards, so a commit on the
 * branch today still finds the act that made it.
 */
import type { CommandRecord } from './command.js';

/**
 * The record whose commit `sha` is, or was before a rebase renamed it: by the sha itself first,
 * then by the sha mapped back through every `rewrote` table in the log, newest first. Undefined
 * when no record made it, which is what a collaborator's commit and a commit from a terminal
 * both answer.
 */
export function recordForCommit(
  records: readonly CommandRecord[],
  sha: string,
): CommandRecord | undefined {
  const rewrites = records
    .filter((r) => r.rewrote !== undefined && r.rewrote.length > 0)
    .reverse()
    .flatMap((r) => r.rewrote!);
  const seen = new Set<string>();
  let current = sha;
  while (!seen.has(current)) {
    seen.add(current);
    const hit = records.find((r) => r.commits?.some((c) => c.sha === current));
    if (hit) return hit;
    const back = rewrites.find((r) => r.to === current);
    if (!back) return undefined;
    current = back.from;
  }
  return undefined;
}
