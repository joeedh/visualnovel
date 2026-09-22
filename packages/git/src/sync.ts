/**
 * The rules behind syncing with a shared copy: what a remote may be called and where it may
 * point, how the author's saves are paired across the rebase a pull performs, and which of
 * git's two sides is "mine" while that rebase is stopped. Pure apart from `finishRebase`, which
 * reads the repository to build the rewrite table once a rebase has completed.
 */
import type { ConflictSide, Git } from './git.js';
import type { CommitKey } from './parse.js';

/** What every sync verb says over a branch with no shared copy to sync with. */
export const NO_UPSTREAM = 'No shared copy is set to sync with; connect one first.';

/**
 * One commit a rebase replaced. `to` is null when the rebase dropped it, as it does an unsent
 * save whose change the shared copy already holds. The same shape `@vn/commands` records.
 */
export interface Rewrite {
  from: string;
  to: string | null;
}

/** Which side the author means, as the pane says it. */
export type MySide = 'mine' | 'theirs';

/**
 * Git's name for each side while a rebase is stopped. The branch being rebased onto is git's
 * `ours` and holds the collaborator's version; the commit being replayed is `theirs` and holds
 * the author's own.
 */
export const REBASE_SIDE: Record<MySide, ConflictSide> = { mine: 'theirs', theirs: 'ours' };

/** The characters git refuses in a refname component, which is what a remote's name is. */
const BAD_NAME = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|^[-.]|[./]$|\.lock$|\//;

/** Why `name` cannot name a remote, or undefined when it can. */
export function remoteNameProblem(name: string, taken: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'A shared copy needs a name.';
  if (BAD_NAME.test(trimmed)) {
    return `“${trimmed}” cannot name a shared copy; use letters, digits, dots, dashes and underscores.`;
  }
  if (taken.includes(trimmed)) return `A shared copy named “${trimmed}” already exists.`;
  return undefined;
}

/** An absolute path on this machine: POSIX, a drive letter, or a UNC share. */
const LOCAL_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Why `url` cannot be a shared copy's address, or undefined when it can. The three forms are an
 * https address, an ssh address in git's `user@host:path` spelling, and a folder on this machine
 * or a drive, which is what a copy on a NAS or a USB stick is.
 */
export function remoteUrlProblem(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return 'A shared copy needs an address.';
  if (/^https:\/\/\S+$/.test(trimmed)) return undefined;
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(trimmed)) return undefined;
  if (/^ssh:\/\/\S+$/.test(trimmed)) return undefined;
  if (LOCAL_PATH.test(trimmed)) return undefined;
  return 'The address must start with https:// or git@, or be a folder on this machine.';
}

/**
 * Pairs the saves listed before a rebase with the ones listed after it, by the key a rebase
 * preserves. Both lists are newest first; an old save with no match was dropped and is recorded
 * with `to: null`. Two saves with one key, which only a repeated identical message makes, pair in
 * order.
 */
export function pairRewrites(before: readonly CommitKey[], after: readonly CommitKey[]): Rewrite[] {
  const spare = new Map<string, string[]>();
  for (const { sha, key } of after) spare.set(key, [...(spare.get(key) ?? []), sha]);
  const out: Rewrite[] = [];
  for (const { sha, key } of before) {
    const to = spare.get(key)?.shift() ?? null;
    if (to === sha) continue;
    out.push({ from: sha, to });
  }
  return out;
}

/** The sha `sha` became, through every table newest first, or `sha` itself when none names it. */
export function resolveRewritten(
  sha: string,
  tables: readonly (readonly Rewrite[])[],
): string | null {
  let current: string | null = sha;
  for (const table of tables) {
    if (current === null) return null;
    const hit = table.find((r) => r.from === current);
    if (hit) current = hit.to;
  }
  return current;
}

/** "Replaying 2 of 3", from where a stopped rebase stands. */
export function replayingSentence(current: number, total: number): string {
  return `Replaying ${current} of ${total}`;
}

/**
 * Git's own sentence from a failed network verb, without the wrapper's prefix and the `fatal:`
 * tag, for a footer and a notification.
 */
export function remoteSentence(message: string): string {
  return message
    .replace(/^git \S+ failed: /, '')
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .filter((l) => l.length > 0)
    .join(' ');
}

/**
 * What a completed rebase did to the saves it replayed: the rewrite table from the saves that
 * stood between `onto` and `origHead` to the ones now between `onto` and HEAD, with every
 * checkpoint on a rewritten save moved to its new sha. Reads the repository after the rebase;
 * the two shas come from before it.
 */
export async function finishRebase(
  git: Git,
  onto: string,
  origHead: string,
): Promise<{ rewrote: Rewrite[]; replayed: number }> {
  const [before, after] = await Promise.all([
    git.rangeKeys(`${onto}..${origHead}`),
    git.rangeKeys(`${onto}..HEAD`),
  ]);
  const rewrote = pairRewrites(before, after);
  if (rewrote.length > 0) {
    const moved = new Map(rewrote.map((r) => [r.from, r.to]));
    for (const c of await git.checkpoints()) {
      const to = moved.get(c.sha);
      if (to === undefined || to === null) continue;
      await git.tag(c.slug, to, c.note ? `${c.name}\n\n${c.note}` : c.name, true);
    }
  }
  return { rewrote, replayed: after.length };
}
