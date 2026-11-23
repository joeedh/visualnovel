import { relative, sep } from 'node:path';
import { dirtyOutsideLogs, OWN_LOGS, type Git } from '@vn/git';
import { samePath } from '@vn/util';
import type { WorkspaceSession } from '../core.js';
import { conflicted, type Owned } from './shared.js';

/** The base art's repository, and the path of its gitlink in the project. */
export interface BaseLink extends Owned {
  path: string;
}

/**
 * Finds the base art when it is a repository of its own nested in the project, owned and
 * checked out.
 */
export async function baseLink(
  session: WorkspaceSession,
  projectRoot: string,
): Promise<BaseLink | null> {
  const found = await session.historyPart.repo('base');
  if (!found || found.missing || !found.owned || samePath(found.root, projectRoot)) return null;
  const path = relative(projectRoot, found.root).split(sep).join('/');
  return { git: found.git, root: found.root, path };
}

/**
 * Runs `step`, the rebase or its continue, and settles each stop on the base art's gitlink by
 * staging the base art's head, when that head holds the shared copy's side. A save whose only
 * change was the gitlink is then empty, and is skipped. A stop with other files in question
 * still waits for the author, with the gitlink already decided.
 */
export async function replay(
  git: Git,
  step: () => Promise<boolean>,
  link: BaseLink | null,
): Promise<boolean> {
  let completed = await step();
  while (!completed && link !== null) {
    const stopped = await conflicted(git);
    if (!stopped.includes(link.path) || !(await holdsCopy(git, link))) return false;
    await git.add([link.path]);
    if (stopped.length > 1) return false;
    const empty = (await git.diff({ staged: true })) === '';
    completed = empty ? await git.rebaseSkip() : await git.rebaseContinue();
  }
  return completed;
}

/** Whether the base art's head holds the commit the shared copy's side of the gitlink names. */
async function holdsCopy(git: Git, link: BaseLink): Promise<boolean> {
  // Mid-rebase, git's `ours` is the shared copy's saves with the author's replayed so far
  const copy = (await git.stagesOf(link.path))[2];
  const head = await link.git.head();
  if (copy === undefined || head === null) return false;
  return link.git.isAncestor(copy, head).catch(() => false);
}

/** Whether anything but the app's logs, and the gitlink `skip` names, is changed on disk. */
export async function dirty(git: Git, skip: string | null): Promise<boolean> {
  if (skip === null) return dirtyOutsideLogs(git);
  const status = await git.status();
  return status.entries.some(
    (e) => e.path !== skip && !OWN_LOGS.some((prefix) => e.path.startsWith(prefix)),
  );
}
