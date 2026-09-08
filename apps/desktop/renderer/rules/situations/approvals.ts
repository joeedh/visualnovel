/** The approvals popup's situations: nothing waiting, and three pictures that are. */
import { situations } from './situation.js';
import type { ApprovalsState } from '../approvals.js';
import type { Approvable } from '@vn/authoring';

const ITEMS: readonly Approvable[] = [
  {
    hash : 'a1b2c3d4',
    kind : 'plate',
    label: 'Café Mori — night',
    slot : 'plate:cafe/night',
    door : 'accept',
  },
  {
    hash       : 'b2c3d4e5',
    kind       : 'portrait',
    label      : 'Aiko — portrait',
    slot       : 'portrait:aiko',
    door       : 'gate',
    characterId: 'aiko',
    blocked    : 'Aiko’s model sheet is not approved yet.',
  },
  {
    hash   : 'c3d4e5f6',
    kind   : 'shot',
    label  : 'arrival — s1',
    slot   : 'shot:arrival/s1',
    door   : 'accept',
    settled: true,
  },
];

export const SITUATIONS = situations<ApprovalsState>(
  { name: 'empty', why: 'Nothing needs approval, so no row is drawn.', state: { items: [] } },
  {
    name : 'waiting',
    why: 'Three pictures wait: a plate, a portrait blocked upstream, and a shot whose slot is already settled; each row opens its picture.',
    state: { items: ITEMS },
  },
);
