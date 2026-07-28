/**
 * The interaction layer: what a *gesture* would do, and which targets would take it.
 *
 * A command answers "what can this app do". An interaction answers "how does a person do it,
 * and what would happen if they dropped it there" — for the direct-manipulation surfaces where
 * that is most of the interface. It adds naming, a carried object, and a target query; it adds
 * no write path, because the terminal of every gesture is a command that already exists.
 *
 * The load-bearing rule is that `targets` is the *same function the drop calls*, not a
 * description of it. That is what the branch editor already did by hand — the refusal shown
 * mid-drag is the refusal that would happen — named here so each new surface inherits it
 * instead of re-establishing it. See `docs/plans/interaction-model.md`.
 */
import { COMMAND_ID } from './command.js';
import type { Invocation } from './dsl.js';
import type { CommandRegistry } from './registry.js';

/**
 * One candidate target, judged. A refusal carries the sentence the command itself would have
 * produced, so an interface can show it before acting and an agent can read it without trying.
 */
export type Verdict =
  | { target: string; accept: true; note: string; invoke: Invocation }
  | { target: string; accept: false; reason: string };

/** Interaction ids are shaped like command ids: `branch.splice`, `timeline.setCoverage`. */
export const INTERACTION_ID = COMMAND_ID;

export interface Interaction<State = any, Carried = string> {
  id: string;
  title: string;
  description: string;
  /** What the user picks up, in words — "a scene card's connect handle". */
  grab: string;
  /** What is carried while the gesture is live — "the scene the wire leaves". */
  carries: string;
  /** What counts as a target — "any wire". */
  accepts: string;
  /**
   * Every command this gesture can terminate in. Checked against the registry by `verify`: an
   * interaction that names a command the app does not have is a lie in the catalog.
   */
  commands: readonly string[];
  /** Whether abandoning the gesture is always free — true for a drag, false for a wizard. */
  cancellable: boolean;
  /**
   * Every candidate target with a verdict, in a stable order. Pure: no IO, no mutation. The
   * caller supplies `State`, so this can run in the renderer mid-drag and in main on request.
   */
  targets(state: State, carried: Carried): Verdict[];
}

/** Identity, but it infers `State`/`Carried` from the literal so `targets` is typed in place. */
export function defineInteraction<State, Carried>(
  interaction: Interaction<State, Carried>,
): Interaction<State, Carried> {
  return interaction;
}

export class InteractionRegistry<State = any> {
  private readonly byId = new Map<string, Interaction<State, any>>();

  register<C>(interaction: Interaction<State, C>): void {
    if (!INTERACTION_ID.test(interaction.id)) {
      throw new Error(`invalid interaction id "${interaction.id}" (expected e.g. "branch.splice")`);
    }
    if (this.byId.has(interaction.id)) {
      throw new Error(`duplicate interaction id "${interaction.id}"`);
    }
    this.byId.set(interaction.id, interaction);
  }

  registerAll(interactions: Interaction<State, any>[]): void {
    for (const i of interactions) this.register(i);
  }

  get(id: string): Interaction<State, any> | undefined {
    return this.byId.get(id);
  }

  list(): Interaction<State, any>[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Throw unless every terminal command exists. This is the whole guarantee that the gesture
   * surface and the command surface cannot drift into two truths, so it runs at build time
   * (the catalog entry) rather than on first use.
   */
  verify(commands: CommandRegistry<any>): void {
    for (const interaction of this.list()) {
      if (interaction.commands.length === 0) {
        throw new Error(`interaction "${interaction.id}" names no terminal command`);
      }
      for (const id of interaction.commands) {
        if (!commands.get(id)) {
          throw new Error(`interaction "${interaction.id}" names unknown command "${id}"`);
        }
      }
    }
  }
}

/**
 * The verdict for one target, or undefined when it is not a candidate at all. "Not a target"
 * and "a target that refuses" are different answers and the caller usually cares which.
 */
export function can<S, C>(
  interaction: Interaction<S, C>,
  state: S,
  carried: C,
  target: string,
): Verdict | undefined {
  return interaction.targets(state, carried).find((v) => v.target === target);
}

/** The serializable half — everything but `targets`, which only runs against live state. */
export interface InteractionCatalogEntry {
  id: string;
  title: string;
  description: string;
  grab: string;
  carries: string;
  accepts: string;
  commands: string[];
  cancellable: boolean;
}

export function toInteractionCatalog(
  registry: InteractionRegistry<any>,
): InteractionCatalogEntry[] {
  return registry
    .list()
    .map(({ id, title, description, grab, carries, accepts, cancellable, commands }) => ({
      id,
      title,
      description,
      grab,
      carries,
      accepts,
      commands: [...commands],
      cancellable,
    }));
}

/**
 * Verdicts as text, in the order given. Fixed shape and no truncation — a caller that drops
 * refusals to keep the output short would be hiding exactly the part worth reading.
 */
export function formatVerdicts(verdicts: Verdict[]): string {
  return verdicts
    .map((v) => `${v.accept ? 'accept' : 'refuse'} · ${v.target} · ${v.accept ? v.note : v.reason}`)
    .join('\n');
}
