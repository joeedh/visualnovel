/**
 * The desktop app's command vocabulary. One registry serves the palette, the menu bar, the
 * DSL, and CDP; `catalog-entry.ts` projects this same registry into the build-time JSON.
 *
 * The definitions are thin wrappers over `WorkspaceSession` — the session stays the place
 * where backend logic lives, and commands only add naming, typed props, and provenance.
 */
import { CommandRegistry } from '@vn/commands';
import { agentClear, agentRun, agentSetMode, agentSetModel } from './agent.js';
import { gateApprove, gateCandidates } from './gate.js';
import { pipelineRun, pipelineStatus } from './pipeline.js';
import { storyExport, storyPlay } from './story.js';
import { viewPalette, viewRoom } from './view.js';
import { workspaceIndex } from './workspace.js';
import type { CommandHost } from './host.js';

export type { CommandHost } from './host.js';

export function createDesktopRegistry(): CommandRegistry<CommandHost> {
  const registry = new CommandRegistry<CommandHost>();
  registry.registerAll([
    agentClear,
    agentRun,
    agentSetMode,
    agentSetModel,
    gateApprove,
    gateCandidates,
    pipelineRun,
    pipelineStatus,
    storyExport,
    storyPlay,
    viewPalette,
    viewRoom,
    workspaceIndex,
  ]);
  return registry;
}
