/**
 * Renderer-local UI state: the root of the path.ux DataAPI and the only thing widgets are
 * allowed to bind to directly. Document state never lands here — `@vn/commands` stays the
 * one write path, so a widget that would change the project dispatches a command instead.
 */
import type { AgentMode } from '../../src/shared/ipc.js';

export class ShellState {
  /**
   * The one selection every editor observes, replacing the rooms' three independent ones.
   * Empty string means nothing selected.
   */
  sceneId = '';
  shotId = '';
  characterId = '';

  /**
   * The task the inspector is looking at. Unlike the three ids above this is machine identity —
   * a content hash that re-keys whenever a prompt changes — so it is **not** persisted: a hash
   * remembered across a re-plan names nothing.
   */
  taskHash = '';

  /**
   * What the header shows. All of it is pushed in by `bridge.ts` from the workspace index,
   * the agent's event stream and `command:ui` — nothing here is authored by a widget, and
   * none of it is persisted, because all of it is re-read at boot.
   */
  projectTitle = '';
  model = 'claude-opus-4-8';
  agentMode: AgentMode = 'plan';
  errors = 0;
  warnings = 0;
  canUndo = false;
  canRedo = false;
  undoLabel = '';
  redoLabel = '';
}
