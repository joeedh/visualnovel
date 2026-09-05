/**
 * The curated tours, checked against the registry they walk the author through.
 *
 * A tour is prose plus invocations, and the prose cannot be tested. The invocations can: a step
 * naming a command that was renamed, or a prop that was dropped, would send the author to a palette
 * form that refuses — and it would do so silently, because a tour is only read when it is run.
 */
import { coerceProps, type CommandContext } from '@vn/commands';
import { createDesktopInteractions } from '../../shared/interactions.js';
import { TOURS, type Tour } from '../../shared/tours.js';
import { createDesktopRegistry } from '../commands/index.js';
import { tourStart } from '../commands/tour.js';
import type { CommandHost } from '../commands/host.js';

const registry = createDesktopRegistry();
const interactions = createDesktopInteractions();

describe('the curated tours', () => {
  it('have distinct ids', () => {
    expect(new Set(TOURS.map((tour) => tour.id)).size).toBe(TOURS.length);
  });

  it('each say what the author will have done', () => {
    for (const tour of TOURS) {
      expect(tour.title.length).toBeGreaterThan(0);
      expect(tour.what.length).toBeGreaterThan(0);
      expect(tour.steps.length).toBeGreaterThan(0);
      for (const step of tour.steps) expect(step.say.length).toBeGreaterThan(0);
    }
  });

  it('name commands that exist', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind === 'select') continue;
        if (step.kind === 'gesture') {
          expect([tour.id, step.id, interactions.get(step.id) !== undefined]).toEqual([
            tour.id,
            step.id,
            true,
          ]);
          continue;
        }
        expect([tour.id, step.id, registry.get(step.id) !== undefined]).toEqual([
          tour.id,
          step.id,
          true,
        ]);
      }
    }
  });

  /**
   * Only the props a step actually carries. A step deliberately leaves the rest to the author, and
   * `coerceProps` would report those as missing, which is the state the author is being walked
   * towards rather than a mistake in the tour.
   */
  it('carry props the commands accept', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind === 'select' || step.kind === 'gesture' || !step.props) continue;
        const command = registry.get(step.id);
        const named = Object.fromEntries(
          Object.entries(command?.props ?? {}).filter(([name]) => name in (step.props ?? {})),
        );
        const result = coerceProps(named, step.props);
        expect([tour.id, step.id, result.ok]).toEqual([tour.id, step.id, true]);
      }
    }
  });

  it('ask the author to type only a prop the command has', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind !== 'input') continue;
        const command = registry.get(step.id);
        expect([tour.id, step.supplies, step.supplies in (command?.props ?? {})]).toEqual([
          tour.id,
          step.supplies,
          true,
        ]);
      }
    }
  });
});

/** `tour.start` is the second entrance a machine-written tour comes in by. */
describe('tour.start', () => {
  const ctx = (): CommandContext<CommandHost> =>
    ({
      host: {
        known: {
          command    : (id: string) => registry.get(id)?.props,
          interaction: (id: string) => interactions.get(id) !== undefined,
          coerce     : coerceProps,
        },
        ui   : () => {},
      },
    }) as unknown as CommandContext<CommandHost>;

  it('starts a custom tour whose steps the catalog accepts', async () => {
    const first = TOURS[0] as Tour;
    await expect(
      tourStart.run({ tour: '', custom: JSON.stringify(first) }, ctx()),
    ).resolves.toEqual({ message: 'Walking through your steps.' });
  });

  /**
   * `show_me` has always checked what the agent writes. `tour.start` took the same JSON from CDP
   * and from the palette's `custom` field unchecked, and a bad id reached a palette filtered to
   * nothing with no form and nothing saying why.
   */
  it('refuses a custom tour naming a command the app does not have', () => {
    const bad = {
      id   : 'x',
      title: 'X',
      what : 'Do a thing.',
      steps: [{ kind: 'command', id: 'story.invent', say: 'Press it.' }],
    };
    expect(() => tourStart.run({ tour: '', custom: JSON.stringify(bad) }, ctx())).toThrow(
      'story.invent',
    );
  });
});
