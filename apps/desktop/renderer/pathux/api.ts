import { DataAPI, DataStruct, buildToolSysAPI } from 'pathux';
import { ShellState } from './state.js';

/**
 * The DataAPI path.ux's `Context` contract requires, registered over `ShellState` alone.
 * It exists so widgets have something to bind to; the project model is reached through
 * IPC and mutated through commands, and neither is described here.
 */
export function defineShellApi(): DataAPI {
  const api = new DataAPI();
  const root = new DataStruct();
  api.setRoot(root);

  const ui = api.mapStruct(ShellState, true);
  ui.string('sceneId', 'sceneId', 'Scene');
  ui.string('shotId', 'shotId', 'Shot');
  ui.string('characterId', 'characterId', 'Character');
  ui.string('docPath', 'docPath', 'Document');
  ui.string('taskHash', 'taskHash', 'Task');

  // The header's facts. Described here rather than read off `ctx.ui` directly so a later
  // widget can bind to them the way any other value in the shell is bound.
  ui.string('projectTitle', 'projectTitle', 'Project');
  ui.string('model', 'model', 'Model');
  ui.string('effort', 'effort', 'Effort');
  ui.string('agentMode', 'agentMode', 'Agent Mode');
  ui.int('errors', 'errors', 'Errors');
  ui.int('warnings', 'warnings', 'Warnings');
  ui.bool('canUndo', 'canUndo', 'Can Undo');
  ui.bool('canRedo', 'canRedo', 'Can Redo');
  ui.string('undoLabel', 'undoLabel', 'Undo Label');
  ui.string('redoLabel', 'redoLabel', 'Redo Label');

  root.struct('ui', 'ui', 'UI', ui);
  // path.ux's last-tool widget reads this off the context root.
  root.dynamicStruct('last_tool', 'last_tool', 'Last Tool');

  buildToolSysAPI(api, false, root);
  return api;
}
