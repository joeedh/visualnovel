/** Every contract `@vn/taskgraph` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { identityTaskHash } from './hash.js';
import { logLastWriterWins, logTombstoneRemoves } from './log.js';
import { logDoneWriters } from './write.js';

export const CONTRACTS: readonly Contract[] = [
  identityTaskHash,
  logLastWriterWins,
  logTombstoneRemoves,
  logDoneWriters,
];
