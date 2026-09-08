/** The Gen Graph pane's situations: what is selected, and whether the level on screen resolves. */
import { situations } from './situation.js';
import type { GroupState } from '../gengraph.js';

const target = { slug: 'plates', group: '', prefix: [] };

export const SITUATIONS = situations<GroupState>(
  {
    name : 'nothing-selected',
    why  : 'Nothing is selected, so Group and Ungroup are refused before anything is weighed.',
    state: { selected: [], groups: [], weighed: {}, target },
  },
  {
    name : 'nodes-selected',
    why  : 'Plain nodes are selected and weighed, so Group is offered and Ungroup is refused.',
    state: {
      selected: [1, 2],
      groups  : [],
      weighed : { group: { ok: true, edit: { op: 'createGroup', nodes: [1, 2] } } },
      target,
    },
  },
  {
    name : 'group-selected',
    why  : 'A group instance is selected and weighed, so Ungroup is offered.',
    state: {
      selected: [4],
      groups  : [4],
      weighed: {
        group  : { ok: false, reason: 'a group instance cannot be grouped again' },
        ungroup: { ok: true, edit: { op: 'ungroup', node: 4 } },
      },
      target,
    },
  },
  {
    name : 'no-level',
    why: 'Nodes are selected but the level on screen no longer resolves, so both are refused with NO_LEVEL.',
    state: {
      selected: [1, 2],
      groups  : [],
      weighed : { group: { ok: true, edit: { op: 'createGroup', nodes: [1, 2] } } },
    },
  },
);
