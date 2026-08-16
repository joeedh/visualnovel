import type { WorkspaceSession } from '../session.js';
import type { SessionStore } from '../sessionstore.js';
import type { UiEffect } from '../../shared/ipc.js';

/** How a file chooser is dressed. Everything is optional: the defaults are the document upload. */
export interface FilePickOptions {
  title?: string;
  buttonLabel?: string;
  /** Extensions offered, without dots. Absent means every file. */
  extensions?: string[];
  /** What that filter is called in the dialog's dropdown. */
  filterName?: string;
  /** One file rather than many — a chooser that fills a single slot. */
  single?: boolean;
}

/**
 * What the desktop's commands are allowed to reach. Everything else a command needs — the
 * workspace root, git, logging, the confirmation gate — comes from `CommandContext`.
 */
export interface CommandHost {
  session: WorkspaceSession;
  /** Persisted UI state. Named `state`, not `session`, to keep it distinct from the above. */
  state: SessionStore;
  /** Push a UI change to the renderer over the `command:ui` event channel. */
  ui(effect: UiEffect): void;
  /**
   * Open a different project: bootstrap it if it is not one yet, then rebuild everything that
   * was bound to the old root. `host.session` is stale the moment this resolves, which is why
   * it lives here and not on the session.
   */
  openWorkspace(root: string): Promise<{ root: string; title: string }>;
  /** The native directory chooser. `undefined` when the user cancelled; throws with no window. */
  pickDirectory(): Promise<string | undefined>;
  /** The native file chooser. Empty when the user cancelled; throws with no window. */
  pickFiles(options?: FilePickOptions): Promise<string[]>;
  /**
   * Ask another command's precondition — the stack's own `check`, reached through the host
   * because a command cannot import the stack that runs it.
   */
  check(
    id: string,
    props: Record<string, unknown>,
  ): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>;
}
