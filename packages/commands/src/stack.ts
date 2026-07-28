/**
 * The command stack: the one execution path for every command, and the history of what ran.
 *
 * Undo is opt-in per command and rests on shadow snapshots (`undo.ts`): with a journal wired,
 * a command marked `undoable` is bracketed by two captures of the document tree, and undo/redo
 * move the working copy between them. Without one, the stack behaves exactly as it did before
 * undo existed and refuses both.
 */
import { formatCommand, parseCommand, DslError } from './dsl.js';
import { coerceProps, type PropSpecMap } from './props.js';
import type { CommandRegistry } from './registry.js';
import type { Snapshot, UndoJournal } from './undo.js';
import type { CommandContext, CommandOutcome, CommandRecord, CommandSource } from './command.js';

const NO_JOURNAL =
  'undo is unavailable here — no snapshot journal is wired (see docs/gitUndoOptions.md)';

export interface CommandStackOptions<Host> {
  registry: CommandRegistry<Host>;
  context: CommandContext<Host>;
  /** Called after every record (ok or error). The host uses it to persist history. */
  onRecord?(record: CommandRecord): void | Promise<void>;
  /** Injectable clock, so tests get stable timestamps. */
  now?(): string;
  /** Enables undo/redo. Absent means the stack refuses both, as it did before undo landed. */
  journal?: UndoJournal;
}

/** What the UI needs to render undo/redo affordances honestly. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  /** The invocation undo would reverse, for a tooltip. Null when there is nothing to undo. */
  undoLabel: string | null;
  redoLabel: string | null;
}

export class CommandStack<Host = unknown> {
  private readonly records: CommandRecord[] = [];
  /** Undone records, most recent last — the redo stack. */
  private readonly undone: CommandRecord[] = [];
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
    const seq = ++this.seq;
    const base = {
      seq,
      id,
      props,
      invocation: formatCommand(id, props),
      source,
      mutating: command.mutating,
      gitHead: head,
      gitDirty: dirty,
      startedAt,
    };

    // Snapshot before the command runs, not after it fails: a command that half-ran has still
    // written, and the pre-state is the only thing that describes where it started.
    const journal = command.undoable && command.mutating ? this.opts.journal : undefined;
    const pre = await this.capture(journal, seq, 'pre');

    try {
      const output = await command.run(props as never, ctx);
      const post = await this.capture(journal, seq, 'post');
      const record: CommandRecord = {
        ...base,
        finishedAt: this.now(),
        status: 'ok',
        message: output.message,
        ...(output.written ? { written: output.written } : {}),
        ...(pre && post
          ? { undo: { pre: pre.commit, post: post.commit, changed: pre.tree !== post.tree } }
          : {}),
      };
      // A fresh act invalidates every redo behind it — the branch they belonged to is gone.
      if (command.mutating) this.undone.length = 0;
      await this.record(record);
      this.prune(journal);
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

  /**
   * Would `id` run right now? The command's own precondition, asked without running it.
   *
   * Three states, not two. `undeclared` is the answer for a command that has no check — absence
   * of a precondition is not permission, and reporting it as an accept would put words in the
   * command's mouth. Props are coerced first, so a check sees exactly what `run` would.
   *
   * Nothing here gates `exec`: a check is a report about now, and `run` re-decides.
   */
  async check(
    id: string,
    raw: Record<string, unknown>,
  ): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }> {
    const command = this.opts.registry.get(id);
    if (!command) return { state: 'refuse', message: `unknown command "${id}"` };

    const coerced = coerceProps(command.props as PropSpecMap, raw);
    if (!coerced.ok) {
      return {
        state: 'refuse',
        message: `invalid props for "${id}": ${coerced.errors.join('; ')}`,
      };
    }
    if (!command.check) {
      return { state: 'undeclared', message: `"${id}" declares no precondition` };
    }

    try {
      const result = await command.check(coerced.value as never, this.opts.context);
      return result.ok
        ? { state: 'accept', message: result.note }
        : { state: 'refuse', message: result.reason };
    } catch (err) {
      // A check that throws has failed to answer, which is not the same as a refusal by the
      // rule — say which, rather than reporting the crash as the command's own reason.
      const detail = err instanceof Error ? err.message : String(err);
      return { state: 'refuse', message: `check for "${id}" failed: ${detail}` };
    }
  }

  /** Most recent last. `limit` keeps the tail. */
  history(limit?: number): CommandRecord[] {
    return limit === undefined ? [...this.records] : this.records.slice(-limit);
  }

  /**
   * The record undo would reverse: the most recent one that actually changed the workspace.
   *
   * Non-mutating records are skipped, so a `view.room` between two edits does not stand in the
   * way, and the stack's own undo/redo entries are skipped because they are history rather
   * than undo points. So is a bracketed command that changed nothing (`undo.changed === false`):
   * its two trees are identical, so reaching past it cannot skip over an edit. A candidate
   * without snapshots at all is still *returned* — undo names it and refuses, rather than
   * quietly reaching past it to an older edit the author never pointed at.
   */
  undoCandidate(): CommandRecord | null {
    const undone = new Set(this.undone.map((r) => r.seq));
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (!record.mutating || record.status !== 'ok' || record.stack) continue;
      if (record.undo && !record.undo.changed) continue;
      if (undone.has(record.seq)) continue;
      return record;
    }
    return null;
  }

  undoState(): UndoState {
    const undo = this.undoCandidate();
    const redo = this.undone[this.undone.length - 1] ?? null;
    const undoable = Boolean(this.opts.journal && undo?.undo);
    return {
      canUndo: undoable,
      canRedo: Boolean(this.opts.journal && redo),
      undoLabel: undoable ? undo!.invocation : null,
      redoLabel: redo ? redo.invocation : null,
    };
  }

  canUndo(): boolean {
    return this.undoState().canUndo;
  }

  canRedo(): boolean {
    return this.undoState().canRedo;
  }

  /** Move the working copy back to the candidate's `pre` snapshot. */
  async undo(): Promise<CommandOutcome> {
    const journal = this.opts.journal;
    if (!journal) return { ok: false, error: NO_JOURNAL };
    const target = this.undoCandidate();
    if (!target) return { ok: false, error: 'nothing to undo' };
    if (!target.undo) {
      return { ok: false, error: `"${target.id}" was not recorded as undoable` };
    }
    return this.move({
      target,
      kind: 'undo',
      expected: target.undo.post,
      to: target.undo.pre,
      done: () => this.undone.push(target),
    });
  }

  /**
   * Move the working copy forward to the record's `post` snapshot.
   *
   * Restoring the post-state, never replaying `invocation` — a replay is a *re-run*, and for
   * anything touching a model or reading changed inputs it would produce a different result
   * (`docs/gitUndoOptions.md` §7). The invocation stays on the record for exactly that use.
   */
  async redo(): Promise<CommandOutcome> {
    const journal = this.opts.journal;
    if (!journal) return { ok: false, error: NO_JOURNAL };
    const target = this.undone[this.undone.length - 1];
    if (!target?.undo) return { ok: false, error: 'nothing to redo' };
    return this.move({
      target,
      kind: 'redo',
      expected: target.undo.pre,
      to: target.undo.post,
      done: () => void this.undone.pop(),
    });
  }

  /** The shared body of undo and redo: guard, restore, record. */
  private async move(opts: {
    target: CommandRecord;
    kind: 'undo' | 'redo';
    expected: string;
    to: string;
    done: () => void;
  }): Promise<CommandOutcome> {
    const journal = this.opts.journal!;
    const { target, kind } = opts;
    const startedAt = this.now();
    let checked;
    try {
      checked = await journal.check(opts.expected);
      if (!checked.ok)
        return { ok: false, error: `cannot ${kind} ${target.invocation}: ${checked.error}` };
      await journal.restore(checked.tree, opts.to);
    } catch (err) {
      return {
        ok: false,
        error: `${kind} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    opts.done();

    const { head, dirty } = await this.gitState();
    const record: CommandRecord = {
      seq: ++this.seq,
      id: `stack.${kind}`,
      props: { target: target.seq },
      invocation: `stack.${kind}(target=${target.seq})`,
      source: 'ui',
      mutating: true,
      stack: kind,
      gitHead: head,
      gitDirty: dirty,
      startedAt,
      finishedAt: this.now(),
      status: 'ok',
      message: `${kind === 'undo' ? 'Undid' : 'Redid'} ${target.invocation}.`,
    };
    await this.record(record);
    return { ok: true, record };
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  /** Snapshot, or degrade to no undo point: provenance must not be able to fail a command. */
  private async capture(
    journal: UndoJournal | undefined,
    seq: number,
    label: 'pre' | 'post',
  ): Promise<Snapshot | null> {
    if (!journal) return null;
    try {
      return await journal.capture(seq, label);
    } catch (err) {
      this.opts.context.log('warn', `undo snapshot (${label} ${seq}) failed: ${String(err)}`);
      return null;
    }
  }

  /** Housekeeping, so it can never fail the command it follows. */
  private prune(journal: UndoJournal | undefined): void {
    if (!journal) return;
    const warn = (err: unknown): void =>
      this.opts.context.log('warn', `undo snapshots not pruned: ${String(err)}`);
    try {
      void journal.prune().catch(warn);
    } catch (err) {
      warn(err);
    }
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
