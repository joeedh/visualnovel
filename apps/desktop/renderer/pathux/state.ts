/**
 * Renderer-local UI state: the root of the path.ux DataAPI and the only thing widgets are
 * allowed to bind to directly. Document state never lands here — `@vn/commands` stays the
 * one write path, so a widget that would change the project dispatches a command instead.
 */
import { DEFAULT_BUDGET, DEFAULT_EFFORT, type BudgetChoice, type EffortChoice } from '@vn/types';
import type { AgentMode } from '../../src/shared/ipc.js';

/** The fields that say what the author is looking at, and the only ones that report a write. */
export type SelectionField =
  | 'sceneId'
  | 'shotId'
  | 'characterId'
  | 'docPath'
  | 'taskHash'
  | 'assetHash';

export class ShellState {
  private selection: Record<SelectionField, string> = {
    sceneId: '',
    shotId: '',
    characterId: '',
    docPath: '',
    taskHash: '',
    assetHash: '',
  };

  /**
   * Called after a selection field changes, with the field that moved.
   *
   * Every editor assigns these fields directly, and path.ux wakes a `DataPathWatcher` only from
   * its own `setValue`. Without this hook a raw assignment reaches no watcher, so neither a widget
   * bound to `ui.sceneId` nor the session's own persistence hears about it. `shell.ts` wires it to
   * `api.notifyChange`.
   */
  onSelect: (field: SelectionField) => void = () => {};

  private select(field: SelectionField, value: string): void {
    if (this.selection[field] === value) return;
    this.selection[field] = value;
    this.onSelect(field);
  }

  /**
   * The one selection every editor observes. Empty string means nothing selected.
   */
  get sceneId(): string {
    return this.selection.sceneId;
  }
  set sceneId(value: string) {
    this.select('sceneId', value);
  }

  get shotId(): string {
    return this.selection.shotId;
  }
  set shotId(value: string) {
    this.select('shotId', value);
  }

  get characterId(): string {
    return this.selection.characterId;
  }
  set characterId(value: string) {
    this.select('characterId', value);
  }

  /**
   * The document a document editor is on, as a workspace-relative path rather than an id. That is
   * what `DocNode.path` and `EntityLinks.sheet` carry, and a note under `wiki/` has no id to name
   * it by. The tree publishes this path and the wiki editor observes it. It persists alongside the
   * ids above.
   */
  get docPath(): string {
    return this.selection.docPath;
  }
  set docPath(value: string) {
    this.select('docPath', value);
  }

  /**
   * The task the inspector is looking at, as `sha256(kind, inputs)` rather than an authored id.
   * Persisted with no repair rule: the hash is stable while its inputs are, and the inspector
   * answers one the current status does not carry by fetching once and drawing nothing.
   */
  get taskHash(): string {
    return this.selection.taskHash;
  }
  set taskHash(value: string) {
    this.select('taskHash', value);
  }

  /**
   * The asset the asset editor is looking at, by content hash. Persisted, and repaired at boot
   * through one `asset.info`: a hash the manifest no longer holds clears the selection, and a
   * superseded take moves to `newerTake` (`../rules/uistate.ts`).
   */
  get assetHash(): string {
    return this.selection.assetHash;
  }
  set assetHash(value: string) {
    this.select('assetHash', value);
  }

  /**
   * What the header shows. All of it is pushed in by `bridge.ts` from the workspace index,
   * the agent's event stream and `command:ui` — nothing here is authored by a widget, and
   * none of it is persisted, because all of it is re-read at boot.
   */
  projectTitle = '';
  /**
   * The open project's root. Two projects may share a title, so anything caching per project (the
   * header's recents list) keys on this rather than on the title.
   */
  projectRoot = '';
  model = 'claude-opus-4-8';
  /** How hard the model is asked to think. Mirrors `WorkspaceSession.effort`, same default. */
  effort: EffortChoice = DEFAULT_EFFORT;
  /**
   * What one agent turn may spend, in non-cached tokens. Unlike everything else here this is
   * persisted, in the install's session file and restored at boot by `installBridge`, because it
   * is a decision about money rather than a fact re-read from the project.
   */
  budget: BudgetChoice = DEFAULT_BUDGET;
  agentMode: AgentMode = 'plan';
  errors = 0;
  warnings = 0;
  /**
   * What the bell shows: unread, unarchived notifications matching the active filter. Pushed by
   * `pathux/notifications.ts` rather than counted in the header, so the badge and the list can
   * never disagree about which ones count.
   */
  unread = 0;
  /**
   * How many pictures are waiting on approval, blocked ones included. Pushed by
   * `pathux/approvals.ts` for the same reason `unread` is: the badge and the list it opens must
   * count the same rows.
   */
  needsApproval = 0;
  canUndo = false;
  canRedo = false;
  undoLabel = '';
  redoLabel = '';

  /**
   * What long-running work main has in flight, named the way its refusals are (`BUSY_RUN`,
   * `BUSY_PASS`, 'an agent turn'), and empty when the session is idle. Everything that must not be
   * started twice reads this rather than keeping a flag of its own. Work that nests reports the
   * outer name, since that is what a second start would collide with.
   */
  busyWhat = '';
  /** How that work is going. Both zero when nothing is running, and while a turn has no count. */
  busyRan = 0;
  busyPending = 0;

  /**
   * A model call that failed and is being tried again: which attempt of how many the author
   * allowed. Both return to zero as soon as the retrying ends, whether it succeeded or failed.
   */
  retryAttempt = 0;
  retryOf = 0;
}
