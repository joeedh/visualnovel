/** Every contract `@vn/scriptedit` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { scriptLineIdsAllocated } from './lineops.js';
import { scriptSceneEditAllOrNothing } from './markers.js';
import { scriptHeadingRestagesShots } from './shotfallout.js';
import { scriptShotOrderFromProse } from './shotorder.js';
import { scriptSceneSourcesOneLoad } from './sources.js';

export const CONTRACTS: readonly Contract[] = [
  scriptLineIdsAllocated,
  scriptSceneSourcesOneLoad,
  scriptSceneEditAllOrNothing,
  scriptShotOrderFromProse,
  scriptHeadingRestagesShots,
];
