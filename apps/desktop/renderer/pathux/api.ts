import { DataAPI, DataStruct, buildToolSysAPI } from 'pathux';
import { defineGraphAPI } from 'pathux-graph';
import type { Graph } from 'pathux-graph';
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
  ui.string('assetHash', 'assetHash', 'Asset');
  ui.string('graphSlug', 'graphSlug', 'Generation Graph');

  // The header's facts. Described here rather than read off `ctx.ui` directly so a later
  // widget can bind to them the way any other value in the shell is bound.
  ui.string('projectTitle', 'projectTitle', 'Project');
  ui.string('model', 'model', 'Model');
  ui.string('effort', 'effort', 'Effort');
  ui.string('budget', 'budget', 'Turn Budget');
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

/**
 * A second DataAPI, rooted on one generation graph, for a Gen Graph pane to hand its view. The
 * pane replaces the graph object on every reload, so `graph` resolves through `getGraph` rather
 * than through a member of the context.
 */
export function defineGraphApi(getGraph: () => Graph | undefined): DataAPI {
  const api = new DataAPI();
  const root = new DataStruct();
  api.setRoot(root);

  root
    .struct('graph', 'graph', 'Generation Graph', defineGraphAPI(api))
    .customGet(() => getGraph());

  // The view's own gestures run as ToolOps, which read their defaults through whichever API the
  // context carries.
  buildToolSysAPI(api, false, root);
  return api;
}
