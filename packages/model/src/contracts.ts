/** Every contract `@vn/model` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { scriptEntityIdMatchesFile, scriptLivenessFromNarrative } from './build.js';
import { scriptSceneOneFile } from './entities.js';
import { scriptLinearOrderListed } from './linear.js';
import { scriptOutfitInherited } from './outfits.js';
import { scriptSceneRoundTrip } from './serialize.js';

export const CONTRACTS: readonly Contract[] = [
  scriptEntityIdMatchesFile,
  scriptLinearOrderListed,
  scriptLivenessFromNarrative,
  scriptOutfitInherited,
  scriptSceneOneFile,
  scriptSceneRoundTrip,
];
