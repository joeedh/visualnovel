/** Every contract `@vn/scriptedit` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { scriptLineIdsAllocated } from './lineops.js';

export const CONTRACTS: readonly Contract[] = [scriptLineIdsAllocated];
