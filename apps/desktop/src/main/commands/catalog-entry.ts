/**
 * The entrypoint `scripts/gen-command-catalog.mjs` bundles and requires. Kept separate from
 * `index.ts` so the generator pulls in only the registry — never Electron.
 */
import { toCatalog, type CommandCatalog } from '@vn/commands';
import { createDesktopRegistry } from './index.js';

export function catalog(): CommandCatalog {
  return toCatalog(createDesktopRegistry(), '@vn/desktop');
}
