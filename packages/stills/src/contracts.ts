/** Every contract `@vn/stills` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import {
  identityHeadingRekeysShots,
  promptsArtNotesAppended,
  promptsPagePanels,
  promptsReviewerSpec,
} from './prompts.js';
import {
  gatePerUnit,
  planningSheetsOnlyWhenWorn,
  takesApprovedMeansAccepted,
  takesCurrencyExclusive,
} from './family.js';
import { promptsRefsAcyclic } from './refcycle.js';
import { scriptProseDriftReported } from './drift.js';
import { identityStagingSheet } from './sheet.js';
import { promptsDecomposeByLineId, providersTextFallback } from './storyboard.js';

export const CONTRACTS: readonly Contract[] = [
  identityStagingSheet,
  identityHeadingRekeysShots,
  promptsArtNotesAppended,
  promptsRefsAcyclic,
  promptsReviewerSpec,
  promptsPagePanels,
  promptsDecomposeByLineId,
  providersTextFallback,
  planningSheetsOnlyWhenWorn,
  takesApprovedMeansAccepted,
  takesCurrencyExclusive,
  gatePerUnit,
  scriptProseDriftReported,
];
