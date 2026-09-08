/** The header bar's situations: what is in flight, and whether this window can call a model. */
import { situations } from './situation.js';
import type { HeaderState } from '../headerbar.js';
import { BUSY_AGENT, BUSY_REPORT, BUSY_RUN } from '../../../src/shared/ipc.js';

const idle: HeaderState = {
  busyWhat     : '',
  live         : true,
  agentMode    : 'plan',
  model        : 'claude-opus-5',
  errors       : 0,
  warnings     : 0,
  needsApproval: 0,
  unread       : 0,
};

export const SITUATIONS = situations<HeaderState>(
  {
    name : 'idle',
    why  : 'Nothing is running, so Run is offered for real and Stop is refused.',
    state: idle,
  },
  {
    name : 'preview',
    why  : 'A browser preview cannot call a model, so Run offers a dry run instead.',
    state: { ...idle, live: false },
  },
  {
    name : 'running',
    why  : 'A pipeline run is in flight, so Run is refused and Stop offers pipeline.stop.',
    state: { ...idle, busyWhat: BUSY_RUN },
  },
  {
    name : 'reporting',
    why  : 'The debug agent is on a turn, so Stop offers report.stop.',
    state: { ...idle, busyWhat: BUSY_REPORT, agentMode: 'execute' },
  },
  {
    name : 'agent-turn',
    why: 'An agent turn is in flight, which the header cannot stop, so Run and Stop are both refused.',
    state: { ...idle, busyWhat: BUSY_AGENT },
  },
  {
    name : 'counts',
    why: 'Validation found errors and warnings, art is waiting and notifications are unread, so the three popup openers carry counts and the problem button is drawn.',
    state: { ...idle, errors: 2, warnings: 1, needsApproval: 3, unread: 5 },
  },
  {
    name : 'warnings',
    why  : 'Only warnings were found, so the problem button counts those.',
    state: { ...idle, warnings: 2 },
  },
);
