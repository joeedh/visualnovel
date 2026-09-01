/**
 * `show_me` from the agent's side: which tours it accepts, which it refuses, and what reaches
 * the renderer.
 *
 * The agent writes these steps without seeing the screen, so the cases worth covering are the
 * wrong ones — a command that does not exist, a prop it does not take, a gesture that is not one.
 */
import { coerceProps, prop } from '@vn/commands';
import { checkTour, readTour, type Known } from '../../shared/tourcheck.js';
import { showMeTool } from '../showme.js';
import type { Step, Tour } from '../../shared/tours.js';

const specs = {
  regenerate: { hash: prop.string('which asset'), note: prop.string('why', { default: '' }) },
  setNotes: { target: prop.string('what to change'), notes: prop.string('what to say') },
};

const known: Known = {
  command: (id) =>
    id === 'asset.regenerate'
      ? specs.regenerate
      : id === 'art.setNotes'
        ? specs.setNotes
        : undefined,
  interaction: (id) => id === 'branch.connect',
  coerce: coerceProps,
};

const tourOf = (steps: Step[]): Tour => ({ id: 'agent', title: 'T', what: 'nothing', steps });

describe('readTour', () => {
  it('refuses text that is not JSON, and says so', () => {
    const read = readTour('{nope');
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toMatch(/not JSON/);
  });

  it('names the field a tour is missing', () => {
    expect(readTour(JSON.stringify({ id: 'a', title: 'b', what: 'c', steps: [] }))).toEqual({
      ok: false,
      reason: 'it needs at least one step',
    });
  });

  it('reads a whole one', () => {
    const tour = tourOf([{ kind: 'command', id: 'asset.regenerate', say: 'Press it.' }]);
    expect(readTour(JSON.stringify(tour))).toEqual({ ok: true, tour });
  });
});

describe('checkTour', () => {
  it('accepts a tour whose steps the app has', () => {
    const tour = tourOf([
      { kind: 'select', itemKind: 'asset', key: 'a1b2', say: 'Pick it.' },
      { kind: 'command', id: 'asset.regenerate', props: { hash: 'a1b2' }, say: 'Press Redraw.' },
      { kind: 'gesture', id: 'branch.connect', carried: 'arrival', say: 'Drag it.' },
    ]);
    expect(checkTour(tour, known)).toEqual([]);
  });

  it('refuses a command the app does not have', () => {
    const tour = tourOf([{ kind: 'command', id: 'asset.redraw', say: 'Press it.' }]);
    expect(checkTour(tour, known)).toEqual(['step 1: there is no command called "asset.redraw"']);
  });

  it('refuses a prop the command does not take', () => {
    const tour = tourOf([
      { kind: 'command', id: 'asset.regenerate', props: { asset: 'a1b2' }, say: 'Press it.' },
    ]);
    expect(checkTour(tour, known)[0]).toContain('takes no prop called "asset"');
  });

  it('refuses a typed prop the command does not take', () => {
    const tour = tourOf([{ kind: 'input', id: 'art.setNotes', supplies: 'text', say: 'Type it.' }]);
    expect(checkTour(tour, known)[0]).toContain('for the author to type');
  });

  it('refuses a gesture the app does not declare', () => {
    const tour = tourOf([{ kind: 'gesture', id: 'branch.wire', carried: 'a', say: 'Drag it.' }]);
    expect(checkTour(tour, known)).toEqual(['step 1: there is no gesture called "branch.wire"']);
  });

  it('refuses a step that tells the author nothing', () => {
    const tour = tourOf([{ kind: 'command', id: 'asset.regenerate', say: '' }]);
    expect(checkTour(tour, known)).toEqual(['step 1 says nothing to the author']);
  });

  /** A step deliberately leaves a prop for the author, and that is the state it walks towards. */
  it('accepts a step that carries none of the command’s props', () => {
    const tour = tourOf([{ kind: 'command', id: 'asset.regenerate', say: 'Go.' }]);
    expect(checkTour(tour, known)).toEqual([]);
  });
});

describe('show_me', () => {
  const deps = (show?: (tour: Tour) => void) => ({
    ...(show ? { show } : {}),
    commands: {
      get: (id: string) => (known.command(id) ? { props: known.command(id)! } : undefined),
    },
    interactions: { get: (id: string) => (known.interaction(id) ? {} : undefined) },
  });

  const args = {
    title: 'Redraw a picture',
    what: 'Draw the portrait again.',
    steps: [{ kind: 'command' as const, id: 'asset.regenerate', say: 'Press Redraw.' }],
  };

  it('hands the tour to the window', async () => {
    const shown: Tour[] = [];
    const result = await showMeTool(deps((tour) => shown.push(tour))).run(args, {} as never);
    expect(result.ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.steps).toEqual(args.steps);
  });

  it('shows nothing and says why when the tour will not run', async () => {
    const shown: Tour[] = [];
    const bad = { ...args, steps: [{ kind: 'command' as const, id: 'asset.redraw', say: 'Go.' }] };
    const result = await showMeTool(deps((tour) => shown.push(tour))).run(bad, {} as never);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no command called "asset.redraw"');
    expect(shown).toHaveLength(0);
  });

  it('refuses where there is no window to point at', async () => {
    const result = await showMeTool(deps()).run(args, {} as never);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('no window');
  });
});
