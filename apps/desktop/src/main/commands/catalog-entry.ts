/**
 * The entrypoint `scripts/gen-command-catalog.mjs` bundles and requires. Kept separate from
 * `index.ts` so the generator pulls in only the registry — never Electron.
 */
import { toCatalog, type CommandCatalog } from '@vn/commands';
import { desktopInteractions } from './interaction.js';
import { createDesktopRegistry } from './index.js';

/**
 * Verifying here is deliberate: it is the earliest place both registries exist, and it runs at
 * build time, so an interaction naming a command the app does not have fails the bundle rather
 * than the first agent that asks.
 */
export function catalog(): CommandCatalog {
  const commands = createDesktopRegistry();
  desktopInteractions.verify(commands);
  return toCatalog(commands, '@vn/desktop', desktopInteractions);
}
