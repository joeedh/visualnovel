/** The command registry: the single place that knows what commands exist. */
import { COMMAND_ID, type Command } from './command.js';
import type { PropSpecMap } from './props.js';

export class CommandRegistry<Host = unknown> {
  private readonly byId = new Map<string, Command<PropSpecMap, Host>>();

  /** Throws on a malformed or duplicate id — both are authoring bugs, not runtime states. */
  register<M extends PropSpecMap>(command: Command<M, Host>): void {
    if (!COMMAND_ID.test(command.id)) {
      throw new Error(`invalid command id "${command.id}" (expected e.g. "gate.approve")`);
    }
    if (this.byId.has(command.id)) {
      throw new Error(`duplicate command id "${command.id}"`);
    }
    this.byId.set(command.id, command as unknown as Command<PropSpecMap, Host>);
  }

  registerAll(commands: Command<any, Host>[]): void {
    for (const c of commands) this.register(c);
  }

  get(id: string): Command<PropSpecMap, Host> | undefined {
    return this.byId.get(id);
  }

  /** All commands, sorted by id, so the catalog and the palette have a stable order. */
  list(): Command<PropSpecMap, Host>[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  namespaces(): string[] {
    return [...new Set(this.list().map((c) => c.id.split('.')[0]!))];
  }
}
