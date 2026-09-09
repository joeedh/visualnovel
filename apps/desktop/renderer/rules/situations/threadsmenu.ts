/**
 * The Threads menu's situations. Every `startedAt` is a string `Date` cannot parse, so
 * `threadLabel` and `threadDetail` skip `toLocaleString` and the derived file reads the same on
 * every machine.
 */
import { situations } from './situation.js';
import type { ThreadsMenuState } from '../convobar.js';
import type { ThreadHeader } from '../../../src/shared/convo.js';

const thread = (id: string, title: string): ThreadHeader =>
  ({ id, title, startedAt: 'earlier', model: 'claude-opus-5' }) as ThreadHeader;

export const SITUATIONS = situations<ThreadsMenuState>(
  {
    name : 'nothing-saved',
    why  : 'No conversation has been saved, so the one row is refused and says why.',
    state: { threads: [] },
  },
  {
    name : 'two-saved',
    why  : 'Two conversations are saved and the second is open, so its row is marked.',
    state: { threads: [thread('t1', 'Casting'), thread('t2', 'Wardrobe')], active: 't2' },
  },
);
