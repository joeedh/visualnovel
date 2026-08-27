/**
 * How many times each document has been written this session.
 *
 * A pane holds its own copy of a document and applies an edit to it before the write that edit
 * became has been answered, so an echo of that write reports a state the pane has already moved
 * past. A version is what lets the two be told apart: the pane knows which versions its own
 * writes produced, so an echo naming one of those is news about nothing.
 *
 * Counters are per path rather than one clock shared across the project, because the comparison a
 * pane makes is about one document. A path nothing has written carries no entry and reads as
 * version zero, which is what lets a pane start at zero and re-read nothing until a write lands.
 *
 * Versions are session-lived and mean nothing across a restart. Nothing persists them, and
 * nothing may: they describe how far one process's windows have been told, not the file.
 */
import type { DocVersions } from '../shared/ipc.js';

export class LiveDocs {
  private readonly versions = new Map<string, number>();

  /** The version `path` carries now. Zero for a document nothing has written this session. */
  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }

  /** Stamp each path as freshly written, and answer the versions they now carry. */
  wrote(paths: readonly string[]): DocVersions {
    const stamped: DocVersions = {};
    for (const path of paths) {
      const next = this.version(path) + 1;
      this.versions.set(path, next);
      stamped[path] = next;
    }
    return stamped;
  }

  /** The versions `paths` carry, stamping nothing. */
  current(paths: readonly string[]): DocVersions {
    const seen: DocVersions = {};
    for (const path of paths) seen[path] = this.version(path);
    return seen;
  }

  /**
   * Forget every version. Called when the workspace switches: the keys are workspace-relative, so
   * under a different root the same key names a different file.
   */
  clear(): void {
    this.versions.clear();
  }
}

/** The one registry in the main process. */
export const liveDocs = new LiveDocs();
