/** The asset editor's situations: what kind of bytes are on screen, and what state they are in. */
import { situations } from './situation.js';
import type { AssetInfo } from '../../../src/shared/ipc.js';

const info = (over: Partial<AssetInfo> = {}): AssetInfo => ({
  hash      : 'a1b2c3d4',
  ext       : 'png',
  kind      : 'location_ref',
  label     : 'Café Mori — night',
  base      : true,
  accepted  : false,
  sourceTask: 't1',
  stale     : false,
  prereqs   : [],
  rungs     : [{ target: 'location:cafe', label: 'Café Mori' }],
  ...over,
});

export const SITUATIONS = situations<AssetInfo | undefined>(
  {
    name : 'nothing',
    why: 'No asset is on screen, so the bar’s four buttons are refused and nothing else is drawn.',
    state: undefined,
  },
  {
    name : 'plate',
    why: 'An accepted plate offers Un-approve, Replace on its slot, the notes and seed boxes of its rung, and a row per picture it was drawn from, greyed where the manifest has no such bytes.',
    state: info({
      accepted: true,
      slot    : 'plate:cafe/night',
      drawnFor: 'plate:cafe/night',
      prereqs: [
        {
          hash    : 'b2c3d4e5',
          label   : 'cafe — concept',
          approved: true,
          note    : 'A concept needs no approval.',
        },
        {
          hash    : 'c3d4e5f6',
          label   : 'moodboard.png',
          approved: false,
          note    : 'The manifest has no record of these bytes.',
          missing : true,
        },
      ],
    }),
  },
  {
    name : 'plate-unaccepted',
    why  : 'A plate not yet accepted offers Accept.',
    state: info({ slot: 'plate:cafe/night', drawnFor: 'plate:cafe/night' }),
  },
  {
    name : 'portrait-unapproved',
    why: 'A portrait is approved through the gate, so Accept becomes gate.approve and Replace is refused.',
    state: info({
      kind : 'portrait',
      label: 'Aiko',
      slot : 'portrait:aiko',
      rungs: [{ target: 'character:aiko', label: 'Aiko' }],
    }),
  },
  {
    name : 'concept',
    why: 'A concept cannot be accepted, but can be promoted to a plate and redrawn from its own prompt.',
    state: info({
      kind            : 'concept',
      base            : false,
      label           : 'Café Mori — an aerial shot at dawn',
      title           : 'an aerial shot at dawn',
      prompt          : 'An aerial shot of Café Mori at dawn.',
      locationVariants: ['night'],
    }),
  },
  {
    name : 'failed',
    why: 'The picture’s task gave up, so the failure band offers its task and a conversation about it.',
    state: info({
      slot   : 'plate:cafe/night',
      failure: {
        task       : 't1',
        status     : 'failed',
        error      : 'the image model returned 503',
        attempts   : 2,
        maxAttempts: 2,
        later      : false,
      },
    }),
  },
  {
    name : 'superseded',
    why  : 'A later render holds the slot, so Accept becomes asset.restore and Replace is refused.',
    state: info({ drawnFor: 'plate:cafe/night', newerTake: 'e5f6a7b8' }),
  },
  {
    name : 'stale',
    why: 'The prompt has moved on since these bytes, so Regenerate offers a pipeline run instead of a requeue.',
    state: info({ stale: true, slot: 'plate:cafe/night', drawnFor: 'plate:cafe/night' }),
  },
  {
    name : 'upload',
    why  : 'An upload is not generated art, so Accept is refused and it fills no slot.',
    state: info({
      kind      : 'reference',
      base      : false,
      label     : 'moodboard.png',
      sourceTask: '',
      rungs     : [],
    }),
  },
);
