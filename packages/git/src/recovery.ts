/**
 * The rules behind taking a save back, going back to one, and naming a checkpoint, decided
 * without writing. The desktop's `git.*` commands and the agent's `git_*` tools both run these, so
 * a refusal reads the same whichever asked, and neither host keeps a rule of its own.
 */
import type { Git } from './git.js';
import type { Checkpoint, HistoryEntry } from './parse.js';
import { slugOf } from './parse.js';

/** The app's own logs, which a read appends to without a commit; dirt there is not the author's. */
export const OWN_LOGS: readonly string[] = ['vngen/state/'];

/** What every restore says over edits on disk that no save holds yet. */
export const DIRTY_TREE = 'There are edits on disk not yet saved; save or discard them first.';

export type Preview<T> = ({ ok: true } & T) | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const short = (sha: string): string => sha.slice(0, 7);

/** One save's entry, by sha, short sha or ref, or undefined for one the repository does not have. */
export async function entryOf(git: Git, ref: string): Promise<HistoryEntry | undefined> {
  const sha = await git.resolve(ref);
  if (sha === null) return undefined;
  const [entry] = await git.history({ from: sha, limit: 1 });
  return entry?.sha === sha ? entry : undefined;
}

/** Whether anything but the app's own logs is changed on disk. */
export async function dirtyOutsideLogs(
  git: Git,
  own: readonly string[] = OWN_LOGS,
): Promise<boolean> {
  const status = await git.status();
  return status.entries.some((e) => !own.some((prefix) => e.path.startsWith(prefix)));
}

/**
 * Whether `sha` can be taken back as a new save, and what that would reverse. A merge, a sweep
 * and the first save are refused by what they are; a later save that changed the same lines is
 * refused by name, with the count of saves since, since going back to a save or bringing back
 * one file is what would work instead.
 */
export async function previewTakeBack(
  git: Git,
  sha: string,
  own: readonly string[] = OWN_LOGS,
): Promise<Preview<{ entry: HistoryEntry; note: string }>> {
  const entry = await entryOf(git, sha);
  if (!entry) return refuse(`No save ${short(sha)} in this repository.`);
  if (entry.parents.length === 0) {
    return refuse('The first save cannot be taken back; it is what the project starts from.');
  }
  if (entry.parents.length > 1) {
    return refuse('This save is a merge, which cannot be taken back on its own.');
  }
  if ('Vn-Sweep' in entry.trailers) {
    return refuse(
      'This save only recorded edits made outside the app; there is nothing to take back.',
    );
  }
  if (await dirtyOutsideLogs(git, own)) return refuse(DIRTY_TREE);
  const dry = await git.revertDryRun(entry.sha);
  if (!dry.clean) {
    if (dry.conflicts.length === 0) {
      return refuse(
        `Taking this save back would not apply cleanly: ${dry.reason ?? 'git refused'}.`,
      );
    }
    const named = await Promise.all(
      dry.conflicts.map(async (path) => {
        const n = await git.countCommits(`${entry.sha}..HEAD`, path);
        return `${path} was changed again in ${n} later save${n === 1 ? '' : 's'}`;
      }),
    );
    return refuse(`${named.join('; ')}; go back to a save instead, or bring back the file.`);
  }
  const n = entry.files.length;
  return {
    ok: true,
    entry,
    note: `Reverses ${n} file${n === 1 ? '' : 's'} as a new save. Nothing in history is deleted.`,
  };
}

/**
 * Whether the whole project can be put back to how it was at `sha`, as a new save, and how many
 * files that moves. Nothing is refused for being old; only edits on disk and being there already.
 */
export async function previewGoBack(
  git: Git,
  sha: string,
  own: readonly string[] = OWN_LOGS,
): Promise<Preview<{ entry: HistoryEntry; paths: string[]; note: string }>> {
  const entry = await entryOf(git, sha);
  if (!entry) return refuse(`No save ${short(sha)} in this repository.`);
  if (entry.sha === (await git.head())) return refuse('The project is already here.');
  if (await dirtyOutsideLogs(git, own)) return refuse(DIRTY_TREE);
  const paths = await git.changedBetween('HEAD', entry.sha);
  const n = paths.length;
  return {
    ok: true,
    entry,
    paths,
    note: `Restores ${n} file${n === 1 ? '' : 's'} to how ${n === 1 ? 'it was' : 'they were'} at that save, as a new save. Nothing in history is deleted.`,
  };
}

/** Whether `name` can become a checkpoint on `sha`, and the slug it would take. */
export async function previewCheckpoint(
  git: Git,
  name: string,
  sha: string,
): Promise<Preview<{ entry: HistoryEntry; slug: string; note: string }>> {
  const trimmed = name.trim();
  if (trimmed === '') return refuse('A checkpoint needs a name.');
  const entry = await entryOf(git, sha);
  if (!entry) return refuse(`No save ${short(sha)} in this repository.`);
  const slug = slugOf(trimmed);
  const taken = (await git.checkpoints()).find((c) => c.slug === slug);
  if (taken) {
    return refuse(
      `A checkpoint named “${taken.name}” already exists${taken.sha === entry.sha ? ' on this save' : ''}; drop it or choose another name.`,
    );
  }
  return { ok: true, entry, slug, note: `Names save ${short(entry.sha)} “${trimmed}”.` };
}

/** The checkpoint `name` names, by its slug or by the name the author typed. */
export function checkpointNamed(
  checkpoints: readonly Checkpoint[],
  name: string,
): Checkpoint | undefined {
  const wanted = name.trim();
  return (
    checkpoints.find((c) => c.slug === wanted) ??
    checkpoints.find((c) => c.name === wanted) ??
    checkpoints.find((c) => c.slug === slugOf(wanted))
  );
}
