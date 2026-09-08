/** The prompt half of the asset editor: which mode the prompt is in, and what each clause holds. */
import { situations } from './situation.js';
import type { PromptChunkInfo, PromptView } from '../../../src/shared/prompt.js';

/** What `promptview.controls` takes: the view, and which clauses have a box open. */
export interface PromptSituation {
  view: PromptView;
  editing: Readonly<Record<string, 'replace' | 'append'>>;
}

const chunk = (over: Partial<PromptChunkInfo> = {}): PromptChunkInfo => ({
  key     : 'palette',
  category: 'palette',
  origin  : { kind: 'builder' },
  text    : 'Palette: #112233.',
  derived : 'Palette: #112233.',
  muted   : false,
  ...over,
});

const subject = (over: Partial<PromptChunkInfo> = {}): PromptChunkInfo =>
  chunk({
    key     : 'subject',
    category: 'subject',
    origin  : { kind: 'character', id: 'aiko', field: 'appearance' },
    text    : 'Aiko, a transfer student.',
    derived : 'Aiko, a transfer student.',
    ...over,
  });

const view = (over: Partial<PromptView> = {}): PromptView => ({
  hash   : 'a1b2c3d4',
  mode   : 'chunks',
  text   : 'Aiko, a transfer student. Palette: #112233.',
  chunks : [subject(), chunk()],
  held   : false,
  missing: [],
  ...over,
});

const plain = (v: PromptView): PromptSituation => ({ view: v, editing: {} });

export const SITUATIONS = situations<PromptSituation>(
  {
    name : 'chunks',
    why: 'A derived prompt in chunks mode: the Chunks segment is refused as current, and an untouched clause’s Reset is refused.',
    state: plain(view()),
  },
  {
    name : 'custom',
    why: 'A whole prompt written by hand: Condense becomes Reconcile, the Custom segment is refused, and its box is drawn.',
    state: plain(view({ mode: 'custom', custom: 'Aiko at dusk.', text: 'Aiko at dusk.' })),
  },
  {
    name : 'agent',
    why: 'A condensed prompt: the Chunks segment clears the agent part rather than the custom one.',
    state: plain(view({ mode: 'agent', agent: { modelId: 'claude-opus-5' } })),
  },
  {
    name : 'frozen',
    why: 'A concept’s prompt was authored, so every segment, Condense and Save are refused with the reason.',
    state: plain(
      view({
        frozen: 'This concept was drawn from a sentence you wrote; edit it in the redraw strip.',
      }),
    ),
  },
  {
    name : 'editing-a-clause',
    why: 'A clause has its Replace box open, so the box is anchored beside the button that opened it.',
    state: { view: view(), editing: { subject: 'replace' } },
  },
  {
    name : 'muted-clause',
    why  : 'A muted clause refuses Mute again and offers Reset.',
    state: plain(view({ chunks: [subject({ muted: true }), chunk()] })),
  },
  {
    name : 'with-refs',
    why: 'A clause carries reference images, one of them drifted, so each is offered to open and to drop.',
    state: plain(
      view({
        chunks: [
          subject({
            refs: [
              { pin: 'c3d4e5f6', ext: 'png', label: 'Aiko — portrait', from: 'portrait:aiko' },
              {
                pin  : 'd4e5f6a7',
                ext  : 'png',
                label: 'Aiko — gala',
                from : 'portrait:aiko/gala',
                drift: true,
              },
            ],
          }),
          chunk(),
        ],
      }),
    ),
  },
);
