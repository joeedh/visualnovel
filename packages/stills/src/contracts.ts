/** Every contract `@vn/stills` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import {
  identityHeadingRekeysShots,
  promptsArtNotesAppended,
  promptsReviewerSpec,
} from './prompts.js';
import { promptsRefsAcyclic } from './refcycle.js';
import { identityStagingSheet } from './sheet.js';
import { promptsDecomposeByLineId, providersTextFallback } from './storyboard.js';

export const CONTRACTS: readonly Contract[] = [
  identityStagingSheet,
  identityHeadingRekeysShots,
  promptsArtNotesAppended,
  promptsRefsAcyclic,
  promptsReviewerSpec,
  promptsDecomposeByLineId,
  providersTextFallback,
];
