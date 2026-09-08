/** The task graph's situations: which characters the run waits on, and what the gate said. */
import { situations } from './situation.js';
import type { GateState } from '../taskGraph.js';

const NOTHING = 'No candidate portraits are on file for aiko yet — run the pipeline first.';

export const SITUATIONS = situations<GateState>(
  {
    name : 'no-gate',
    why  : 'No run is waiting at a gate, so nothing is drawn.',
    state: { pending: [], gates: {} },
  },
  {
    name : 'gate-unasked',
    why: 'A gate is pending and not yet asked about, so the button is offered live before the round trip.',
    state: { pending: ['aiko'], gates: {} },
  },
  {
    name : 'gate-with-candidates',
    why: 'The check refuses the blank hash but candidates are on file, so the button stays live and the sentence goes to its tooltip.',
    state: {
      pending: ['aiko'],
      gates: {
        aiko: {
          check     : { state: 'refuse', message: 'Name the portrait to approve.' },
          candidates: 3,
        },
      },
    },
  },
  {
    name : 'gate-without-candidates',
    why  : 'Nothing is on file to approve, so the button is refused with the command’s sentence.',
    state: {
      pending: ['aiko'],
      gates  : { aiko: { check: { state: 'refuse', message: NOTHING }, candidates: 0 } },
    },
  },
);
