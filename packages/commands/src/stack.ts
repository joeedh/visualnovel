/**
 * The command stack: the one execution path for every command, and the history of what ran.
 *
 * v1 is undo-less by decision. Every record still captures the document repo's HEAD, whether
 * the worktree was dirty, and which paths were written — the inputs each strategy in
 * `docs/gitUndoOptions.md` needs — so adding undo later is additive, not a rewrite.
 */
import { formatCommand, parseCommand, DslError } from './dsl.js';
import { coerceProps, type PropSpecMap } from './props.js';
import type { CommandRegistry } from './registry.js';
import type { CommandContext, CommandOutcome, CommandRecord, CommandSource } from './command.js';

const UNDO_MESSAGE =
  'undo is not implemented yet — strategies are surveyed in docs/gitUndoOptions.md';

export interface CommandStackOptions<Host> {
  registry: CommandRegistry<Host>;
  context: CommandContext<Host>;
  /** Called after every record (ok or error). The host uses it to persist history. */
  onRecord?(record: CommandRecord): void | Promise<void>;
  /** Injectable clock, so tests get stable timestamps. */
  now?(): string;
}

export class CommandStack<Host = unknown> {
  private readonly records: CommandRecord[] = [];
  private seq = 0;

  constructor(private readonly opts: CommandStackOptions<Host>) {}

  /** Parse and run a DSL invocation, e.g. `gate.approve(characterId='aiko')`. */
  async execDsl(text: string, source: CommandSource): Promise<CommandOutcome> {
    let parsed;
    try {
      parsed = parseCommand(text);
    } catch (err) {
      const message = err instanceof DslError ? err.message : String(err);
      return { ok: false, error: `could not parse command: ${message}` };
    }
    return this.exec(parsed.id, parsed.props, source);
  }

  async exec(
    id: string,
    raw: Record<string, unknown>,
    source: CommandSource,
  ): Promise<CommandOutcome> {
    const command = this.opts.registry.get(id);
    if (!command) return { ok: false, error: `unknown command "${id}"` };

    const coerced = coerceProps(command.props as PropSpecMap, raw);
    if (!coerced.ok) {
      return { ok: false, error: `invalid props for "${id}": ${coerced.errors.join('; ')}` };
    }
    const props = coerced.value;

    const ctx = this.opts.context;
    if (command.confirm) {
      if (!ctx.confirm) {
        return { ok: false, error: `"${id}" needs confirmation, but no gate is wired` };
      }
      if (!(await ctx.confirm(`Run ${command.title}?`))) {
        return { ok: false, error: `"${id}" was declined` };
      }
    }

    const startedAt = this.now();
    const { head, dirty } = await this.gitState();
    const base = {
      seq: ++this.seq,
      id,
      props,
      invocation: formatCommand(id, props),
      source,
      mutating: command.mutating,
      gitHead: head,
      gitDirty: dirty,
      startedAt,
    };

    try {
      const output = await command.run(props as never, ctx);
      const record: CommandRecord = {
        ...base,
        finishedAt: this.now(),
        status: 'ok',
        message: output.message,
        ...(output.written ? { written: output.written } : {}),
      };
      await this.record(record);
      return { ok: true, record, data: output.data };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const record: CommandRecord = {
        ...base,
        finishedAt: this.now(),
        status: 'error',
        message: `${id} failed`,
        error,
      };
      await this.record(record);
      return { ok: false, error, record };
    }
  }

  /** Most recent last. `limit` keeps the tail. */
  history(limit?: number): CommandRecord[] {
    return limit === undefined ? [...this.records] : this.records.slice(-limit);
  }

  canUndo(): boolean {
    return false;
  }

  canRedo(): boolean {
    return false;
  }

  undo(): Promise<CommandOutcome> {
    return Promise.resolve({ ok: false, error: UNDO_MESSAGE });
  }

  redo(): Promise<CommandOutcome> {
    return Promise.resolve({ ok: false, error: UNDO_MESSAGE });
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  /**
   * Provenance, not control flow: a project need not be a git repo, so failures here
   * degrade to `{ head: null, dirty: false }` rather than failing the command.
   */
  private async gitState(): Promise<{ head: string | null; dirty: boolean }> {
    try {
      const { git } = this.opts.context;
      if (!(await git.isRepo())) return { head: null, dirty: false };
      return { head: await git.head(), dirty: await git.isDirty() };
    } catch {
      return { head: null, dirty: false };
    }
  }

  private async record(record: CommandRecord): Promise<void> {
    this.records.push(record);
    try {
      await this.opts.onRecord?.(record);
    } catch (err) {
      this.opts.context.log('warn', `command history not persisted: ${String(err)}`);
    }
  }
}
