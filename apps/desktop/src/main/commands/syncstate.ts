/**
 * The one refusal every command that plans from the worktree shares: nothing runs against a tree
 * that is half one save and half another.
 */
import { operationOf, type Git } from '@vn/git';

/** The sentence, in the author's words; a merge or a revert is folded into "getting their saves". */
export const SYNC_UNFINISHED = 'Getting their saves is unfinished; finish or give it up first.';

/** `SYNC_UNFINISHED` while a rebase, merge or revert is in progress in `git`, else undefined. */
export async function syncRefusal(git: Git): Promise<string | undefined> {
  return operationOf(await git.inProgress()) ? SYNC_UNFINISHED : undefined;
}
