/** Every contract `@vn/providers` declares, for the index generator; the barrel does not export it. */
import type { Contract } from '@vn/contracts';
import { providersTransientRetry } from './backends/transient.js';
import { providersModelIdRoutes } from './factory.js';

export const CONTRACTS: readonly Contract[] = [providersModelIdRoutes, providersTransientRetry];
