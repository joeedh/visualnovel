import type { Tool } from './core.js';
import {
  readFileTool,
  listWorkspaceTool,
  searchTool,
  listArchiveTool,
  searchBibleTool,
} from './workspace.js';
import {
  validateInputsTool,
  parseFountainTool,
  storyGraphTool,
  extractEntitiesTool,
} from './validate.js';
import {
  editCharacterTool,
  editLocationTool,
  createCharacterTool,
  createLocationTool,
} from './characters.js';
import { editSceneTool, editBranchesTool } from './scenes.js';
import { setOutfitTool, setVariantTool } from './outfits.js';
import {
  readShotsTool,
  setCoverageTool,
  setPanelsTool,
  proposeStoryboardTool,
  writeStoryboardTool,
} from './storyboard.js';
import { generateImageTool, listImagesTool, editImageTool } from './images.js';
import {
  listAssetsTool,
  artNotesTool,
  setArtNotesTool,
  viewImageTool,
  regenerateAssetTool,
  approveAssetsTool,
  unapproveAssetsTool,
} from './assets.js';
import { readAssetGraphTool, editAssetGraphTool, runAssetGraphTool } from './assetgraph.js';
import { writeFileTool, editFileTool, regenerateContextTool, updateContextTool } from './files.js';
import { discoverSkillsTool, createSkillTool, editSkillTool, runSkillTool } from './skills.js';
import {
  gitStatusTool,
  gitLogTool,
  gitShowTool,
  gitDiffTool,
  gitCommitTool,
  gitRevertTool,
  gitRestoreTool,
  gitCheckpointTool,
  gitInitTool,
  resolveConflictTool,
} from './git.js';

export * from './core.js';

/** Every built-in tool, in a stable order. */
export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listWorkspaceTool,
  searchTool,
  listArchiveTool,
  searchBibleTool,
  validateInputsTool,
  parseFountainTool,
  storyGraphTool,
  extractEntitiesTool,
  editCharacterTool,
  editLocationTool,
  createCharacterTool,
  createLocationTool,
  editSceneTool,
  editBranchesTool,
  setOutfitTool,
  setVariantTool,
  readShotsTool,
  setCoverageTool,
  setPanelsTool,
  proposeStoryboardTool,
  writeStoryboardTool,
  generateImageTool,
  listImagesTool,
  editImageTool,
  listAssetsTool,
  artNotesTool,
  setArtNotesTool,
  viewImageTool,
  regenerateAssetTool,
  approveAssetsTool,
  unapproveAssetsTool,
  readAssetGraphTool,
  editAssetGraphTool,
  runAssetGraphTool,
  writeFileTool,
  editFileTool,
  updateContextTool,
  regenerateContextTool,
  discoverSkillsTool,
  createSkillTool,
  editSkillTool,
  runSkillTool,
  gitStatusTool,
  gitLogTool,
  gitShowTool,
  gitDiffTool,
  gitCommitTool,
  gitRevertTool,
  gitRestoreTool,
  gitCheckpointTool,
  gitInitTool,
  resolveConflictTool,
] as Tool[];

/** Build a name→tool registry from the built-in tools (plus optional extras). */
export function createRegistry(extra: Tool[] = []): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const t of [...ALL_TOOLS, ...extra]) map.set(t.name, t);
  return map;
}
