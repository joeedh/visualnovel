/**
 * The effect layer: a closed vocabulary for what a control does without running a command.
 *
 * A command describes what the app can do to the project. An effect describes what a surface does
 * to itself: publish a selection, expand a tree node, open a menu, change what a pane shows, arm a
 * drag. It adds naming and typed props and nothing else. It has no `run`, no `check` and no
 * provenance, because the handler stays a closure beside the record that names it, and the model
 * reads the record. See `docs/plans/archive/INDEX.md#pseudo-commands-and-a-controls-effects`.
 *
 * The load-bearing rule is that an effect id and a command id never coincide, so a record's `id`
 * names one thing in one registry. `verify` is what enforces it, at build time.
 */
import { COMMAND_ID } from './command.js';
import type { InteractionRegistry } from './interaction.js';
import type { PropSpecMap } from './props.js';
import type { CommandRegistry } from './registry.js';

/** Effect ids are shaped like command ids: `ui.publish`, `pane.view`. */
export const EFFECT_ID = COMMAND_ID;

/**
 * The prop an effect declares to name a gesture. `verify` checks every value of an enum prop by
 * this name against the interaction registry, so an effect cannot arm a drag nothing declares.
 */
export const GESTURE_PROP = 'interaction';

export interface Effect<M extends PropSpecMap = PropSpecMap> {
  id: string;
  title: string;
  description: string;
  /** Closed values are `prop.oneOf`, so a typo is refused where the props are coerced. */
  props: M;
}

/** Identity, but it infers the prop map from the literal so a helper can be typed over it. */
export function defineEffect<M extends PropSpecMap>(effect: Effect<M>): Effect<M> {
  return effect;
}

export class EffectRegistry {
  private readonly byId = new Map<string, Effect>();

  register(effect: Effect): void {
    if (!EFFECT_ID.test(effect.id)) {
      throw new Error(`invalid effect id "${effect.id}" (expected e.g. "pane.view")`);
    }
    if (this.byId.has(effect.id)) {
      throw new Error(`duplicate effect id "${effect.id}"`);
    }
    this.byId.set(effect.id, effect);
  }

  registerAll(effects: readonly Effect[]): void {
    for (const effect of effects) this.register(effect);
  }

  get(id: string): Effect | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): Effect[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Throw where an effect id is also a command id, or where a gesture prop names an interaction
   * the app does not declare. Runs where the catalog is built, so a collision fails the bundle
   * rather than the first record that carries it.
   */
  verify(commands: CommandRegistry<any>, interactions?: InteractionRegistry<any>): void {
    for (const effect of this.list()) {
      if (commands.get(effect.id)) {
        throw new Error(`effect "${effect.id}" is also a command`);
      }
      const gesture = effect.props[GESTURE_PROP];
      if (!gesture || gesture.kind !== 'enum' || !interactions) continue;
      for (const id of gesture.values ?? []) {
        if (!interactions.get(id)) {
          throw new Error(`effect "${effect.id}" names unknown interaction "${id}"`);
        }
      }
    }
  }
}
