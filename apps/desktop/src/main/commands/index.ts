/**
 * The desktop app's command vocabulary. One registry serves the palette, the menu bar, the
 * DSL, and CDP; `catalog-entry.ts` projects this same registry into the build-time JSON.
 *
 * The definitions are thin wrappers over `WorkspaceSession` — the session stays the place
 * where backend logic lives, and commands only add naming, typed props, and provenance.
 */
import { CommandRegistry } from '@vn/commands';
import { agentClear, agentRun, agentSetMode, agentSetModel } from './agent.js';
import { commandCheck } from './command.js';
import { gateApprove, gateCandidates } from './gate.js';
import { interactionList, interactionTargets } from './interaction.js';
import { pipelineRun, pipelineStatus } from './pipeline.js';
import {
  storyAssignLineIds,
  storyCoverage,
  storyExport,
  storyGraph,
  storyPlay,
  storyRemoveChoice,
  storySetChoice,
  storySetCoverage,
  storySetNext,
  storySpliceScene,
} from './story.js';
import { viewMode, viewPalette, viewPanelSize, viewRoom } from './view.js';
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
    commandCheck,
    gateApprove,
    gateCandidates,
    interactionList,
    interactionTargets,
    pipelineRun,
    pipelineStatus,
    storyAssignLineIds,
    storyCoverage,
    storyExport,
    storyGraph,
    storyPlay,
    storyRemoveChoice,
    storySetChoice,
    storySetCoverage,
    storySetNext,
    storySpliceScene,
    viewMode,
    viewPalette,
    viewPanelSize,
    viewRoom,
    workspaceIndex,
  ]);
  return registry;
}
