/**
 * The entrypoint `scripts/gen-command-catalog.mjs` bundles and requires. Kept separate from
 * `index.ts` so the generator pulls in only the registry — never Electron.
 */
import { toCatalog, type CommandCatalog, type CommandRegistry } from '@vn/commands';
import { desktopInteractions } from './interaction.js';
import { createDesktopRegistry, type CommandHost } from './index.js';

/**
 * The one projection, which the `command:catalog` channel serves and the generator writes to
 * `commands.json`. Two call sites drifted once — the channel omitted the interactions — so there
 * is now only one.
 *
 * Verifying here is deliberate: it is the earliest place both registries exist, and it runs at
 * build time, so an interaction naming a command the app does not have fails the bundle rather
 * than the first agent that asks.
 */
export function catalogOf(commands: CommandRegistry<CommandHost>): CommandCatalog {
  desktopInteractions.verify(commands);
  return toCatalog(commands, '@vn/desktop', desktopInteractions);
}

/** The catalog of a fresh registry — what the build-time generator bundles and requires. */
export function catalog(): CommandCatalog {
  return catalogOf(createDesktopRegistry());
}
