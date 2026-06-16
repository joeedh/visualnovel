import { VnError } from '@vn/util';

/** A git CLI invocation failed (non-zero exit, or git not installed). */
export class GitError extends VnError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('GIT', message, options);
  }
}
