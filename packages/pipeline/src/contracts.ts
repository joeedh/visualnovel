/** Every contract `@vn/pipeline` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { planningStoryboardOnRequest } from './decompose.js';
import { planningIncremental } from './planner.js';
import { executionResumeFromJournal } from './requests.js';
import { executionTaskLogDiagnostic } from './tasklog.js';

export const CONTRACTS: readonly Contract[] = [
  planningStoryboardOnRequest,
  planningIncremental,
  executionResumeFromJournal,
  executionTaskLogDiagnostic,
];
