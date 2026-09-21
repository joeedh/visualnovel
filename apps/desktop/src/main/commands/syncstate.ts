/**
 * The one refusal every command that plans from the worktree shares: nothing runs against a tree
 * that is half one save and half another.
 */
import { operationOf, type Git } from '@vn/git';
import { SYNC_UNFINISHED } from '../../shared/history.js';

export { SYNC_UNFINISHED };

/** `SYNC_UNFINISHED` while a rebase, merge or revert is in progress in `git`, else undefined. */
export async function syncRefusal(git: Git): Promise<string | undefined> {
  return operationOf(await git.inProgress()) ? SYNC_UNFINISHED : undefined;
}
