/**
 * The desktop app's command vocabulary. One registry serves the palette, the menu bar, the
 * DSL, and CDP; `catalog/catalog-entry.ts` projects this same registry into the build-time JSON.
 *
 * The definitions are thin wrappers over `WorkspaceSession` — the session stays the place
 * where backend logic lives, and commands only add naming, typed props, and provenance.
 */
import { CommandRegistry } from '@vn/commands';
import { assetsCommands } from './assets/index.js';
import { docsCommands } from './docs/index.js';
import { pipelineCommands } from './pipeline/index.js';
import { projectCommands } from './project/index.js';
import { shellCommands } from './shell/index.js';
import { storyCommands } from './story/index.js';
import { vcsCommands } from './vcs/index.js';
import type { CommandHost } from './host.js';

export type { CommandHost } from './host.js';

export function createDesktopRegistry(): CommandRegistry<CommandHost> {
  const registry = new CommandRegistry<CommandHost>();
  registry.registerAll([
    ...assetsCommands,
    ...docsCommands,
    ...pipelineCommands,
    ...projectCommands,
    ...shellCommands,
    ...storyCommands,
    ...vcsCommands,
  ]);
  return registry;
}
