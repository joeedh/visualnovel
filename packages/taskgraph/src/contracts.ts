/** Every contract `@vn/taskgraph` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { logDoneWriters } from './write.js';

export const CONTRACTS: readonly Contract[] = [logDoneWriters];
