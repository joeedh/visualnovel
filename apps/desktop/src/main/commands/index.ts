/**
 * The desktop app's command vocabulary. One registry serves the palette, the menu bar, the
 * DSL, and CDP; `catalog-entry.ts` projects this same registry into the build-time JSON.
 *
 * The definitions are thin wrappers over `WorkspaceSession` — the session stays the place
 * where backend logic lives, and commands only add naming, typed props, and provenance.
 */
import { CommandRegistry } from '@vn/commands';
import { agentClear, agentRun, agentSetMode, agentSetModel } from './agent.js';
import { bibleSearch } from './bible.js';
import { commandCheck } from './command.js';
import { gateApprove, gateCandidates } from './gate.js';
import { interactionList, interactionTargets } from './interaction.js';
import { pipelineRun, pipelineStatus } from './pipeline.js';
import {
  storyAssignLineIds,
  storyCoverage,
  storyDeleteLine,
  storyDeleteScene,
  storyExport,
  storyGraph,
  storyInsertLine,
  storyMergeScene,
  storyMoveLine,
  storyMoveShot,
  storyNewScene,
  storyPlay,
  storyRemoveChoice,
  storyScreenplay,
  storySetChoice,
  storySetCoverage,
  storySetLineText,
  storySetNext,
  storySetOutfit,
  storySetSceneOutfit,
  storySetSpeaker,
  storySpliceScene,
  storySplitScene,
} from './story.js';
import { viewClose, viewFocus, viewLayout, viewOpen, viewPalette } from './view.js';
import {
  workspaceDoctree,
  workspaceFiletree,
  workspaceImport,
  workspaceIndex,
  workspaceOpen,
  workspacePick,
  workspaceRecent,
  workspaceReindex,
} from './workspace.js';
import type { CommandHost } from './host.js';

export type { CommandHost } from './host.js';

export function createDesktopRegistry(): CommandRegistry<CommandHost> {
  const registry = new CommandRegistry<CommandHost>();
  registry.registerAll([
    agentClear,
    agentRun,
    agentSetMode,
    agentSetModel,
    bibleSearch,
    commandCheck,
    gateApprove,
    gateCandidates,
    interactionList,
    interactionTargets,
    pipelineRun,
    pipelineStatus,
    storyAssignLineIds,
    storyCoverage,
    storyDeleteLine,
    storyDeleteScene,
    storyExport,
    storyGraph,
    storyInsertLine,
    storyMergeScene,
    storyMoveLine,
    storyMoveShot,
    storyNewScene,
    storyPlay,
    storyRemoveChoice,
    storyScreenplay,
    storySetChoice,
    storySetCoverage,
    storySetLineText,
    storySetNext,
    storySetOutfit,
    storySetSceneOutfit,
    storySetSpeaker,
    storySpliceScene,
    storySplitScene,
    viewClose,
    viewFocus,
    viewLayout,
    viewOpen,
    viewPalette,
    workspaceDoctree,
    workspaceFiletree,
    workspaceImport,
    workspaceIndex,
    workspaceOpen,
    workspacePick,
    workspaceRecent,
    workspaceReindex,
  ]);
  return registry;
}
