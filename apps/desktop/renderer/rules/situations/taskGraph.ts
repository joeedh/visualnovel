/**
 * The task graph's situations: which characters the run waits on, what the gate said, and which
 * task cards are drawn.
 */
import { situations } from './situation.js';
import type { GateState } from '../taskGraph.js';
import type { ImageParams } from '@vn/types';
import type { Task } from '../../../src/shared/ipc.js';

const NOTHING = 'No candidate portraits are on file for aiko yet — run the pipeline first.';

const PARAMS: ImageParams = { modelId: 'mock-image' };

const CARDS: readonly Task[] = [
  {
    hash    : 'f1e2d3c4',
    kind    : 'shot_image',
    deps    : [],
    status  : 'done',
    attempts: [],
    inputs  : { shotId: 'arrival__s1', prompt: '', refs: [], params: PARAMS },
  },
  {
    hash    : 'c9d8e7f6',
    kind    : 'portrait',
    deps    : [],
    status  : 'pending',
    attempts: [],
    inputs  : { characterId: 'aiko', prompt: '', refs: [], params: PARAMS },
  },
];

export const SITUATIONS = situations<GateState>(
  {
    name : 'no-gate',
    why  : 'No run is waiting at a gate, so only the bar is drawn: Tidy, Fit and Refresh.',
    state: { pending: [], gates: {} },
  },
  {
    name : 'scoped',
    why: 'The graph is narrowed to one picture’s work and the search box has found two slots, so the bar offers Overview and each hit offers its scope.',
    state: {
      pending: [],
      gates  : {},
      scoped : 'cafe night',
      results: [
        { key: 'plate:cafe/night', label: 'cafe night' },
        { key: 'plate:cafe/day', label: 'cafe day' },
      ],
    },
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
  {
    name : 'cards',
    why: 'Two task cards are drawn: a shot names its scene and shot, a portrait names its character.',
    state: {
      pending: [],
      gates  : {},
      cards: {
        tasks    : CARDS,
        selection: {
          sceneId    : '',
          shotId     : '',
          characterId: '',
          docPath    : '',
          assetHash  : '',
          graphSlug  : '',
        },
      },
    },
  },
);
