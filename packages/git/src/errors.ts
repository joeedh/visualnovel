import { VnError } from '@vn/util';

/** A git CLI invocation failed (non-zero exit, or git not installed). */
export class GitError extends VnError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('GIT', message, options);
  }
}

/**
 * A commit was refused because the repository is mid-rebase, mid-merge or mid-revert. Its own
 * class so commit-on-save can skip the repository rather than report a failure.
 */
export class InProgressError extends GitError {
  constructor(readonly operation: 'rebase' | 'merge' | 'revert') {
    super(`a ${operation} is in progress; nothing is committed until it finishes or is abandoned`);
  }
}
