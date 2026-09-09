/**
 * The conversation bar's situations. Every `context` and `spent` stays below 1000, so no tooltip
 * goes through `toLocaleString`'s digit grouping and the derived file reads the same on every
 * machine.
 */
import { situations } from './situation.js';
import type { ConvoBarState } from '../convobar.js';
import { emptyConvo, type Convo, type ResumeHeader } from '../../../src/shared/convo.js';
import { NATIVE_VERSION, type OpenedThread } from '../../../src/shared/threads.js';

const MODEL = 'claude-opus-5';

const header: ResumeHeader = {
  v       : NATIVE_VERSION,
  thread  : 't1',
  at      : '2026-08-22T14:00:28.041Z',
  backend : 'native',
  vendor  : 'anthropic',
  model   : MODEL,
  sections: [],
};

const opened = (resume: OpenedThread['resume']): OpenedThread =>
  ({
    id         : 't1',
    title      : 'Casting',
    startedAt  : header.at,
    items      : [],
    compactions: [],
    resume,
  }) as OpenedThread;

const convo = (over: Partial<Convo> = {}): Convo => ({ ...emptyConvo(''), ...over });

const base: ConvoBarState = {
  convo    : convo(),
  opened   : undefined,
  model    : MODEL,
  agentMode: 'plan',
  effort   : 'medium',
  budget   : '200k',
  spent    : 0,
};

export const SITUATIONS = situations<ConvoBarState>(
  {
    name : 'empty',
    why: 'Nothing has been said, so Compact is refused, and nothing is open, so Continue and Stop are refused.',
    state: base,
  },
  {
    name : 'after-a-turn',
    why: 'A turn has run, so Compact is offered with the context size and the budget label shows the spend.',
    state: {
      ...base,
      convo: convo({ feed: [{ id: 1, role: 'user', text: 'hello' }], context: 842 }),
      spent: 612,
    },
  },
  {
    name : 'mid-turn',
    why  : 'A turn is in flight, so Stop is offered and Compact is refused until it ends.',
    state: {
      ...base,
      convo: convo({ busy: true, feed: [{ id: 1, role: 'user', text: 'hello' }] }),
    },
  },
  {
    name : 'plan-proposed',
    why  : 'The agent proposed a plan, so its card offers Reject and Approve.',
    state: {
      ...base,
      convo: convo({
        feed: [{ id: 1, role: 'user', text: 'recast Aiko' }],
        plan: {
          id  : 1,
          plan: {
            summary: 'Recast Aiko as a transfer student.',
            steps  : ['Edit her sheet'],
            files  : [],
          },
        },
      }),
    },
  },
  {
    name : 'confirming',
    why  : 'An always-confirm tool is waiting, so its card offers Deny and Allow, naming the tool.',
    state: {
      ...base,
      convo: convo({
        busy   : true,
        feed   : [{ id: 1, role: 'user', text: 'run it' }],
        confirm: { id: 2, tool: 'run_pipeline', detail: 'Run the pipeline over 3 shots.' },
      }),
    },
  },
  {
    name : 'reading',
    why: 'A saved conversation is open for reading, so Continue is offered and Compact is refused.',
    state: { ...base, opened: opened({ header }) },
  },
  {
    name : 'reading-unresumable',
    why: 'The open conversation was recorded before it could be continued, so Continue is refused with the reason.',
    state: { ...base, opened: opened({}) },
  },
  {
    name : 'no-effort-knob',
    why  : 'The bound model has no reasoning-effort setting, so the effort menu is refused.',
    state: { ...base, model: 'claude-haiku-4-5-20251001' },
  },
);
