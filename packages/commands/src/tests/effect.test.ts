import { toCatalog, toEffectCatalog } from '../catalog.js';
import { defineCommand } from '../command.js';
import { defineEffect, EffectRegistry } from '../effect.js';
import { defineInteraction, InteractionRegistry } from '../interaction.js';
import { coerceProps, prop } from '../props.js';
import { CommandRegistry } from '../registry.js';

const look = defineEffect({
  id         : 'pane.look',
  title      : 'Look',
  description: 'Change what the pane shows.',
  props      : { what: prop.oneOf(['near', 'far'], 'how far') },
});

const drag = defineEffect({
  id         : 'drag.start',
  title      : 'Start a drag',
  description: 'Arm a gesture.',
  props      : { interaction: prop.oneOf(['room.walk'], 'which gesture') },
});

const enter = defineCommand({
  id         : 'room.enter',
  title      : 'Enter',
  description: 'Go through a door.',
  mutating   : true,
  props      : { door: prop.string('which door') },
  async run() {
    return { message: 'in' };
  },
});

const walk = defineInteraction<Record<string, boolean>>({
  id         : 'room.walk',
  title      : 'Walk',
  description: 'Drag yourself onto a door.',
  grab       : 'yourself',
  carries    : 'you',
  accepts    : 'a door',
  commands   : ['room.enter'],
  cancellable: true,
  targets    : () => [],
});

const registryOf = (...effects: Parameters<EffectRegistry['register']>[0][]) => {
  const registry = new EffectRegistry();
  registry.registerAll(effects);
  return registry;
};

describe('EffectRegistry', () => {
  it('rejects a malformed or duplicate id, like the command registry', () => {
    const registry = new EffectRegistry();
    registry.register(look);
    expect(() => registry.register(look)).toThrow(/duplicate/);
    expect(() => registry.register({ ...look, id: 'look' })).toThrow(/invalid effect id/);
  });

  it('lists in id order and answers `has`', () => {
    const registry = registryOf(look, drag);
    expect(registry.list().map((e) => e.id)).toEqual(['drag.start', 'pane.look']);
    expect(registry.has('pane.look')).toBe(true);
    expect(registry.has('room.enter')).toBe(false);
  });

  it('refuses an effect whose id is also a command', () => {
    const commands = new CommandRegistry();
    commands.register(enter);
    const registry = registryOf({ ...look, id: 'room.enter' });
    expect(() => registry.verify(commands)).toThrow(/effect "room.enter" is also a command/);
    expect(() => registryOf(look).verify(commands)).not.toThrow();
  });

  it('refuses a gesture prop naming an interaction the app does not declare', () => {
    const commands = new CommandRegistry();
    commands.register(enter);
    const interactions = new InteractionRegistry();
    expect(() => registryOf(drag).verify(commands, interactions)).toThrow(
      /unknown interaction "room.walk"/,
    );
    interactions.register(walk);
    expect(() => registryOf(drag).verify(commands, interactions)).not.toThrow();
  });

  it('coerces a closed value through the same authority a command uses', () => {
    expect(coerceProps(look.props, { what: 'near' })).toEqual({
      ok   : true,
      value: { what: 'near' },
    });
    expect(coerceProps(look.props, { what: 'sideways' }).ok).toBe(false);
  });
});

describe('the catalog', () => {
  it('projects an effect as its id, sentences and props', () => {
    expect(toEffectCatalog(registryOf(look))).toEqual([
      {
        id         : 'pane.look',
        title      : 'Look',
        description: 'Change what the pane shows.',
        props: [
          {
            name       : 'what',
            kind       : 'enum',
            description: 'how far',
            required   : true,
            values     : ['near', 'far'],
          },
        ],
      },
    ]);
  });

  it('carries the effects beside the commands only when a registry is given', () => {
    const commands = new CommandRegistry();
    commands.register(enter);
    expect(toCatalog(commands, 'x')).not.toHaveProperty('effects');
    expect(toCatalog(commands, 'x', undefined, registryOf(look)).effects?.map((e) => e.id)).toEqual(
      ['pane.look'],
    );
  });
});
