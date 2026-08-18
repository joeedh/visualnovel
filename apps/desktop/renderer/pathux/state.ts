/**
 * Renderer-local UI state: the root of the path.ux DataAPI and the only thing widgets are
 * allowed to bind to directly. Document state never lands here — `@vn/commands` stays the
 * one write path, so a widget that would change the project dispatches a command instead.
 */
import { DEFAULT_EFFORT, type EffortChoice } from '@vn/types';
import type { AgentMode } from '../../src/shared/ipc.js';

export class ShellState {
  /**
   * The one selection every editor observes, replacing the rooms' independent ones. Empty
   * string means nothing selected.
   */
  sceneId = '';
  shotId = '';
  characterId = '';

  /**
   * The document a document editor is on: a workspace-relative path, not an id. That is what
   * `DocNode.path` and `EntityLinks.sheet` already carry, and a note under `wiki/` has no id to
   * name it by. It is a selection like the three above — the tree publishes it, the wiki editor
   * observes it — and it persists with them.
   */
  docPath = '';

  /**
   * The task the inspector is looking at. Unlike the three ids above this is machine identity —
   * a content hash that re-keys whenever a prompt changes — so it is **not** persisted: a hash
   * remembered across a re-plan names nothing.
   */
  taskHash = '';

  /**
   * The asset the asset editor is looking at, by content hash. Machine identity like `taskHash`
   * and **not** persisted for the same reason: an asset regenerated between launches has
   * different bytes, so the hash remembered from last time names nothing.
   */
  assetHash = '';

  /**
   * What the header shows. All of it is pushed in by `bridge.ts` from the workspace index,
   * the agent's event stream and `command:ui` — nothing here is authored by a widget, and
   * none of it is persisted, because all of it is re-read at boot.
   */
  projectTitle = '';
  /**
   * The open project's root. Two projects may share a title, so anything caching per project —
   * the header's recents list is the one — keys on this rather than on what it is called.
   */
  projectRoot = '';
  model = 'claude-opus-4-8';
  /** How hard the model is asked to think. Mirrors `WorkspaceSession.effort`, same default. */
  effort: EffortChoice = DEFAULT_EFFORT;
  agentMode: AgentMode = 'plan';
  errors = 0;
  warnings = 0;
  /**
   * What the bell shows: unread, unarchived notifications matching the active filter. Pushed by
   * `pathux/notifications.ts` rather than counted in the header, so the badge and the list can
   * never disagree about which ones count.
   */
  unread = 0;
  canUndo = false;
  canRedo = false;
  undoLabel = '';
  redoLabel = '';

  /**
   * What long-running work main has in flight, named the way its refusals are ('a pipeline run',
   * 'an agent turn'), and empty when the session is idle. Everything that must not be started
   * twice reads this rather than keeping a flag of its own.
   */
  busyWhat = '';
  /** How that work is going. Both zero when nothing is running, and while a turn has no count. */
  busyRan = 0;
  busyPending = 0;
}
