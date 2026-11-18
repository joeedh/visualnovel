/** Every contract `@vn/types` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { promptsClauseList, promptsRefOnClause } from './prompt.js';

export const CONTRACTS: readonly Contract[] = [promptsClauseList, promptsRefOnClause];
