/**
 * The interaction layer: what a gesture would do, and which targets would take it.
 *
 * A command describes what the app can do. An interaction describes how a person performs it and
 * what would happen if they dropped it on a given target, for the direct-manipulation surfaces
 * where that is most of the interface. It adds naming, a carried object, and a target query. It
 * adds no write path, because every gesture terminates in a command that already exists.
 *
 * The load-bearing rule is that `targets` is the same function the drop calls rather than a
 * description of it, so the refusal shown mid-drag is the refusal that would happen. The branch
 * editor already did this by hand; naming it here lets each new surface inherit it instead of
 * re-establishing it. See `docs/plans/archive/interaction-model.md`.
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

/** Interaction ids are shaped like command ids: `branch.splice`, `timeline.cover`. */
export const INTERACTION_ID = COMMAND_ID;

/**
 * The target a verdict names when the carried token itself is the problem: it parses to nothing,
 * or names something the state does not have. See `Interaction.targets`.
 */
export const UNRESOLVED = 'unresolved';

export interface Interaction<State = any> {
  id: string;
  title: string;
  description: string;
  /** What the user picks up, in words — "a scene card's connect handle". */
  grab: string;
  /**
   * What is carried while the gesture is live — "the scene the wire leaves". The carried value is
   * always a string token, since a gesture is named by a pointer and the thing under it has an
   * id. An interaction wanting structure encodes it (`<shotId>#start`) and parses it in
   * `targets`.
   */
  carries: string;
  /** What counts as a target — "any wire". */
  accepts: string;
  /**
   * Every command this gesture can terminate in. Checked against the registry by `verify`: an
   * interaction naming a command the app does not have makes the catalog wrong.
   */
  commands: readonly string[];
  /** Whether abandoning the gesture is always free — true for a drag, false for a wizard. */
  cancellable: boolean;
  /**
   * Every candidate target with a verdict, in a stable order. The caller supplies `State`, so
   * this can run in the renderer mid-drag and in main on request.
   *
   * Synchronous and pure, and it has to stay that way: it runs once per pointer move, so it may
   * not await, read the filesystem, or touch a session. A command's precondition is `check`
   * (async, reaches the host) for that reason rather than being folded in here.
   *
   * A carried token that names nothing produces a refusal rather than an empty list. An empty list
   * is a claim about the targets, saying there is nowhere to drop the token; a token naming a shot
   * the scene does not have is a claim about the grab, and the caller needs to be told which. Such
   * a verdict names `UNRESOLVED` unless the state has a truer target to hang it on.
   */
  targets(state: State, carried: string): Verdict[];
}

/** Identity, but it infers `State` from the literal so `targets` is typed in place. */
export function defineInteraction<State>(interaction: Interaction<State>): Interaction<State> {
  return interaction;
}

export class InteractionRegistry<State = any> {
  private readonly byId = new Map<string, Interaction<State>>();

  register(interaction: Interaction<State>): void {
    if (!INTERACTION_ID.test(interaction.id)) {
      throw new Error(`invalid interaction id "${interaction.id}" (expected e.g. "branch.splice")`);
    }
    if (this.byId.has(interaction.id)) {
      throw new Error(`duplicate interaction id "${interaction.id}"`);
    }
    this.byId.set(interaction.id, interaction);
  }

  registerAll(interactions: Interaction<State>[]): void {
    for (const i of interactions) this.register(i);
  }

  get(id: string): Interaction<State> | undefined {
    return this.byId.get(id);
  }

  list(): Interaction<State>[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Throw unless every terminal command exists. This is what keeps the gesture surface and the
   * command surface from drifting apart, so it runs at build time (the catalog entry) rather
   * than on first use.
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
export function can<S>(
  interaction: Interaction<S>,
  state: S,
  carried: string,
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
 * Verdicts as text, in the order given. Fixed shape and no truncation, because the refusals are
 * the part worth reading.
 */
export function formatVerdicts(verdicts: Verdict[]): string {
  return verdicts
    .map((v) => `${v.accept ? 'accept' : 'refuse'} · ${v.target} · ${v.accept ? v.note : v.reason}`)
    .join('\n');
}
