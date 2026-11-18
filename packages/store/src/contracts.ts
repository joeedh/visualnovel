/** Every contract `@vn/store` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { storageManifestQueue, storageTwoRoots } from './assetstore.js';
import { scriptEntityByTag } from './entities.js';
import { storageStoryboardKept } from './shots.js';

export const CONTRACTS: readonly Contract[] = [
  storageTwoRoots,
  storageManifestQueue,
  scriptEntityByTag,
  storageStoryboardKept,
];
