/** Every contract `@vn/gengraph` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { graphsInstanceEditsOverride } from './edit.js';
import { graphsSocketRenameMigrates } from './migrate.js';
import { graphsGroupNodeKey } from './nodekey.js';

export const CONTRACTS: readonly Contract[] = [
  graphsGroupNodeKey,
  graphsInstanceEditsOverride,
  graphsSocketRenameMigrates,
];
