import {
  can,
  defineInteraction,
  formatVerdicts,
  InteractionRegistry,
  toInteractionCatalog,
  type Verdict,
} from '../interaction.js';
import { CommandRegistry } from '../registry.js';
import { defineCommand } from '../command.js';
import { prop } from '../props.js';

/** A toy domain: a room with doors, only some of which are unlocked. */
type Doors = Record<string, boolean>;

const walk = defineInteraction<Doors, string>({
  id: 'room.walk',
  title: 'Walk through a door',
  description: 'Drag yourself onto a door.',
  grab: 'yourself',
  carries: 'you',
  accepts: 'a door',
  commands: ['room.enter'],
  cancellable: true,
  targets: (doors, who) =>
    Object.entries(doors).map(([door, open]) =>
      open
        ? {
            target: door,
            accept: true,
            note: `${who} goes through ${door}.`,
            invoke: { id: 'room.enter', props: { door } },
          }
        : { target: door, accept: false, reason: `${door} is locked.` },
    ),
});

const enter = defineCommand({
  id: 'room.enter',
  title: 'Enter',
  description: 'Go through a door.',
  mutating: true,
  props: { door: prop.string('which door') },
  async run() {
    return { message: 'in' };
  },
});

const doors: Doors = { north: true, south: false };

describe('InteractionRegistry', () => {
  it('rejects a malformed or duplicate id, like the command registry', () => {
    const registry = new InteractionRegistry<Doors>();
    registry.register(walk);
    expect(() => registry.register(walk)).toThrow(/duplicate/);
    expect(() => registry.register({ ...walk, id: 'walk' })).toThrow(/invalid interaction id/);
  });

  it('verifies every terminal command exists, so the two surfaces cannot drift', () => {
    const registry = new InteractionRegistry<Doors>();
    registry.register(walk);

    const commands = new CommandRegistry();
    commands.register(enter);
    expect(() => registry.verify(commands)).not.toThrow();
    expect(() => registry.verify(new CommandRegistry())).toThrow(/unknown command "room.enter"/);
  });

  it('rejects an interaction that terminates in nothing at all', () => {
    const registry = new InteractionRegistry<Doors>();
    registry.register({ ...walk, commands: [] });
    expect(() => registry.verify(new CommandRegistry())).toThrow(/names no terminal command/);
  });
});

describe('targets', () => {
  it('judges every candidate, carrying the invocation an accepted drop would run', () => {
    const verdicts = walk.targets(doors, 'you');
    expect(verdicts.map((v) => v.target)).toEqual(['north', 'south']);
    expect(verdicts[0]).toEqual({
      target: 'north',
      accept: true,
      note: 'you goes through north.',
      invoke: { id: 'room.enter', props: { door: 'north' } },
    });
  });

  it('distinguishes a refusing target from one that is not a target at all', () => {
    expect(can(walk, doors, 'you', 'south')).toMatchObject({ accept: false });
    expect(can(walk, doors, 'you', 'ceiling')).toBeUndefined();
  });
});

describe('projections', () => {
  it('drops `targets` from the catalog, since it only runs against live state', () => {
    const registry = new InteractionRegistry<Doors>();
    registry.register(walk);
    const [entry] = toInteractionCatalog(registry);
    expect(entry).toEqual({
      id: 'room.walk',
      title: 'Walk through a door',
      description: 'Drag yourself onto a door.',
      grab: 'yourself',
      carries: 'you',
      accepts: 'a door',
      commands: ['room.enter'],
      cancellable: true,
    });
    expect(entry).not.toHaveProperty('targets');
  });

  it('formats verdicts in the order given, keeping the refusals', () => {
    const verdicts: Verdict[] = walk.targets(doors, 'you');
    expect(formatVerdicts(verdicts)).toBe(
      ['accept · north · you goes through north.', 'refuse · south · south is locked.'].join('\n'),
    );
  });
});
