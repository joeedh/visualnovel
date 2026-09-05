/**
 * The curated tours: the few things people ask for often enough to be worth writing down and
 * testing, rather than asking the agent to work out each time.
 *
 * Every step names a command that exists and props `coerceProps` accepts, checked against the live
 * registry in `main/tests/tours.test.ts`. A step whose command no pane draws is not a mistake — the
 * palette is the floor, and `guide` routes there.
 *
 * None of them is a `gesture`, which needs the id of a scene or a shot in the project at hand.
 * That is the tail the agent writes a tour for, from the workspace index.
 *
 * Here rather than beside the resolution rules because main's `tour.*` commands name these ids in
 * their own description, and main may not reach into the renderer.
 */
import type { PropValue } from './ipc.js';

/** One thing the author is asked to do. */
export type Step =
  | {
      kind: 'command';
      id: string;
      props?: Record<string, PropValue>;
      /** What to tell the author. Written as an instruction, because it is one. */
      say: string;
    }
  | {
      kind: 'input';
      id: string;
      props?: Record<string, PropValue>;
      /** The prop the author types. Must be one the anchor says it supplies. */
      supplies: string;
      say: string;
    }
  | { kind: 'select'; itemKind: string; key: string; say: string }
  | {
      kind: 'gesture';
      /** An interaction id — `branch.connect`, `timeline.cover`. */
      id: string;
      /** What the author picks up, as the interaction spells it: a scene id, a `<shot>#start`. */
      carried: string;
      /** Where to drop it. Left out to point at every target that would take it. */
      target?: string;
      say: string;
    };

export interface Tour {
  id: string;
  title: string;
  /** One sentence naming what the author will have done by the end. */
  what: string;
  steps: readonly Step[];
}

export const TOURS: readonly Tour[] = [
  {
    id   : 'first-key',
    title: 'Set up a model key',
    what : 'Put an API key where the app can find it, and prove it works.',
    steps: [
      {
        kind: 'command',
        id  : 'app.openKeyLink',
        say : 'Open the provider’s console from the Setup pane and create a key there.',
      },
      {
        kind    : 'input',
        id      : 'project.setKey',
        supplies: 'key',
        say     : 'Paste the key into the box beside it. It goes to one file and is never logged.',
      },
      {
        kind: 'command',
        id  : 'project.testKey',
        say : 'Press Test key. It makes one small real call and says whether the key works.',
      },
    ],
  },
  {
    id   : 'art-direction',
    title: 'Steer how something is drawn',
    what : 'Say what you want changed about a picture, and render it again.',
    steps: [
      {
        kind    : 'input',
        id      : 'art.setNotes',
        supplies: 'notes',
        say: 'Open the picture you want to change and type what you want different in its art notes.',
      },
      {
        kind: 'command',
        id  : 'asset.regenerate',
        say: 'Press Redraw. The note goes into the prompt, and the old take is kept beside the new one.',
      },
    ],
  },
  {
    id   : 'first-run',
    title: 'Approve a portrait and render',
    what : 'Get past the approval gate and render everything that is waiting on it.',
    steps: [
      {
        kind: 'command',
        id  : 'gate.approve',
        say : 'Pick the portrait you want the rest of the art drawn from, and approve it.',
      },
      {
        kind: 'command',
        id  : 'pipeline.run',
        say : 'Press Run. Everything that was blocked on the gate is planned and drawn.',
      },
    ],
  },
];

export const tourById = (id: string): Tour | undefined => TOURS.find((tour) => tour.id === id);
