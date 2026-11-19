/** Every contract `@vn/constraint-solver` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { storageBaseUnavailable } from './refuse.js';
import { identitySlotsBeforeTasks } from './solve.js';

export const CONTRACTS: readonly Contract[] = [identitySlotsBeforeTasks, storageBaseUnavailable];
