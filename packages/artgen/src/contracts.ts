/** Every contract `@vn/artgen` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { identityConceptNoNode } from './concept.js';
import { promptsArtRungsShared } from './setnotes.js';

export const CONTRACTS: readonly Contract[] = [identityConceptNoNode, promptsArtRungsShared];
