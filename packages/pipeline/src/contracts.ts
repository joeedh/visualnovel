/** Every contract `@vn/pipeline` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { planningStoryboardOnRequest } from './decompose.js';

export const CONTRACTS: readonly Contract[] = [planningStoryboardOnRequest];
