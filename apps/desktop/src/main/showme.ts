/**
 * `show_me`: the agent writes a tour for the question at hand and the app walks the author
 * through it. The tail the three curated tours do not cover.
 *
 * It lives in the desktop app rather than in `@vn/authoring` because a tour points at controls,
 * and `vnauthor` has none. That is also why the push is a session dependency: where there is no
 * window, the tool refuses and names the host that can.
 *
 * The tour is checked before the author sees any of it, by the same `coerceProps` a loose CDP
 * value goes through. Nothing here writes: the tour says what to press and never presses it.
 */
import { z } from 'zod';
import type { Tool } from '@vn/authoring';
import { coerceProps, type PropSpecMap } from '@vn/commands';
import { checkTour, type Known } from '../shared/tourcheck.js';
import type { Step, Tour } from '../shared/tours.js';

/** How the tool is described to the model, including what a step may be. */
const DESCRIPTION = [
  'Walk the author through doing something in the app themselves: each step rings the control to',
  'press and says what it does, and the app waits for them to press it. Use this when they ask how',
  'to do something, rather than describing where a button is or doing it for them.',
  'Command ids and props are the ones in the command catalog; gesture ids are the ones',
  '`interaction.list` names. A step whose command no pane draws still works — the app opens the',
  'command palette on it — so prefer the command that does the job over the one you know has a',
  'button. Steps that name a scene, shot or asset need its real id, from the workspace index.',
].join(' ');

const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const props = z.record(propValue).describe('the props the step already knows').optional();
const say = z.string().describe('what to tell the author, written as an instruction');

/**
 * A step, as the model writes one. `z.union` rather than `z.discriminatedUnion` because the tool
 * catalog renders through `jsonSchemaOf`, which knows `ZodUnion` and would emit an empty schema
 * for the discriminated kind.
 */
const step = z.union([
  z.object({
    kind: z.enum(['command']).describe('a button to press'),
    id: z.string().describe('the command it runs'),
    props,
    say,
  }),
  z.object({
    kind: z.enum(['input']).describe('a box to type in'),
    id: z.string().describe('the command the box commits'),
    props,
    supplies: z.string().describe('the prop the author types'),
    say,
  }),
  z.object({
    kind: z.enum(['select']).describe('a subject to pick before the step that acts on it'),
    itemKind: z.string().describe('scene, shot, asset, character, location'),
    key: z.string().describe('its id'),
    say,
  }),
  z.object({
    kind: z.enum(['gesture']).describe('a drag'),
    id: z.string().describe('the interaction id, from interaction.list'),
    carried: z.string().describe('what the author picks up, as that interaction spells it'),
    target: z
      .string()
      .describe('where to drop it; leave out to point at every place it fits')
      .optional(),
    say,
  }),
]);

const ARGS = z.object({
  title: z.string().describe('a few words naming what this walks through'),
  what: z.string().describe('one sentence on what the author will have done by the end'),
  steps: z.array(step).min(1),
});

type ShowMeArgs = z.infer<typeof ARGS>;

export interface ShowMeDeps {
  /** Push the tour to the window. Absent where there is none, and the tool then refuses. */
  show?: (tour: Tour) => void;
  /** The app's commands, for the ids and props a step is checked against. */
  commands: { get(id: string): { props: PropSpecMap } | undefined };
  /** The app's gestures, for the same reason. */
  interactions: { get(id: string): unknown };
}

/**
 * The tool, ready to hand to `createRegistry`. A factory rather than a constant because what it
 * pushes to and what it checks against both belong to one open workspace.
 */
export function showMeTool(deps: ShowMeDeps): Tool<ShowMeArgs> {
  const known: Known = {
    command: (id) => deps.commands.get(id)?.props,
    interaction: (id) => deps.interactions.get(id) !== undefined,
    coerce: coerceProps,
  };
  return {
    name: 'show_me',
    description: DESCRIPTION,
    mutating: false,
    args: ARGS,
    run(args) {
      const tour: Tour = {
        id: 'agent',
        title: args.title,
        what: args.what,
        steps: args.steps as Step[],
      };
      if (!deps.show) {
        return Promise.resolve({
          ok: false,
          output: 'A tour points at controls, and there is no window here to point at.',
        });
      }
      const problems = checkTour(tour, known);
      if (problems.length > 0) {
        return Promise.resolve({
          ok: false,
          output: `That tour will not run:\n${problems.join('\n')}`,
        });
      }
      deps.show(tour);
      return Promise.resolve({
        ok: true,
        output: `Walking the author through ${tour.steps.length} step(s), which they press themselves.`,
      });
    },
  };
}
