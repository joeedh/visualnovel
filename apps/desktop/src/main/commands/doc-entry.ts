/**
 * The entrypoint `scripts/gen-command-table.mjs` bundles and requires. Kept separate from
 * `catalog-entry.ts` so the doc-only `notes` field never rides through the same code path as
 * the runtime catalog (`command:catalog`, tooltip defaults).
 */
import { toDocIndex, type DocCommandEntry } from '@vn/commands';
import { createDesktopRegistry } from './index.js';

/** The doc index of a fresh registry — what the table generator bundles and requires. */
export function docIndex(): DocCommandEntry[] {
  return toDocIndex(createDesktopRegistry());
}
