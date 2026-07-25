import type { WorkspaceSession } from '../session.js';
import type { SessionStore } from '../sessionstore.js';
import type { UiEffect } from '../../shared/ipc.js';

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
}
