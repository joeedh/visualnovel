/** Every contract `@vn/scheduler` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { executionTargetClosure } from './scheduler.js';

export const CONTRACTS: readonly Contract[] = [executionTargetClosure];
