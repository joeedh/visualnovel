/**
 * The one execution path for every command, and the history of what ran.
 *
 * Undo is opt-in per command and rests on shadow snapshots (`undo.ts`): with a journal wired,
 * a command marked `undoable` is bracketed by two captures of the document tree, and undo/redo
 * move the working copy between them. Without one, the stack behaves exactly as it did before
 * undo existed and refuses both.
 */
import { digestProps } from './digest.js';
import { formatCommand, parseCommand, DslError } from './dsl.js';
import { coerceProps, type PropSpecMap, type PropValue } from './props.js';
import type { CommandRegistry } from './registry.js';
import type { Committer, CommitResult } from './commit.js';
import type { Snapshot, UndoJournal, UndoPoint } from './undo.js';
import type {
  Command,
  CommandContext,
  CommandOutcome,
  CommandRecord,
  CommandSource,
} from './command.js';

const NO_JOURNAL =
  'undo is unavailable here — no snapshot journal is wired (see docs/history/gitUndoOptions.md)';

/**
 * How long a batch waits for the next deferring act before committing itself. Bounds how long an
 * author who edits and then stops leaves a dirty worktree behind.
 */
export const BATCH_IDLE_MS = 1500;

export interface CommandStackOptions<Host> {
  registry: CommandRegistry<Host>;
  context: CommandContext<Host>;
  /** Called after every record (ok or error). The host uses it to persist history. */
  onRecord?(record: CommandRecord): void | Promise<void>;
  /** Injectable clock, so tests get stable timestamps. */
  now?(): string;
  /** Enables undo/redo. Absent means the stack refuses both, as it did before undo landed. */
  journal?: UndoJournal;
  /**
   * Enables commit-on-save. Absent means the stack moves no ref, which keeps a bare stack
   * (tests, testkit, the CLI) out of the author's history.
   */
  committer?: Committer;
  /**
   * Injectable timer for the idle flush, so tests fire it rather than sleeping. `set` returns a
   * handle that is handed back to `clear`. Defaults to the global `setTimeout`/`clearTimeout`.
   */
  timer?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  /**
   * Called when a batch fails to commit, with the records still pending. A commit failure must
   * not fail the acts that already ran and already wrote, so the stack keeps the batch for the
   * next flush to retry and reports it here; the desktop turns that into a durable notification.
   */
  onCommitError?(error: unknown, records: CommandRecord[]): void;
}

/** One step between an undo point's two snapshots, in either direction. */
interface Move {
  target: CommandRecord;
  kind: 'undo' | 'redo';
  point: UndoPoint;
  from: 'pre' | 'post';
  to: 'pre' | 'post';
  /** Applied once the working copy has moved, to update the redo stack. */
  done: () => void;
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
  /** Records whose commits were held back, oldest first. */
  private pending: CommandRecord[] = [];
  /** Mutating commands run one at a time; this is the tail of that queue. */
  private chain: Promise<void> = Promise.resolve();
  private flushing: Promise<CommitResult[]> | null = null;
  /** The armed idle flush, if the batch is waiting on one. */
  private idle: unknown = null;
  private disposed = false;

  constructor(private readonly opts: CommandStackOptions<Host>) {}

  /** Parse and run a DSL invocation, e.g. `gate.approve(characterId='aiko')`. */
  async execDsl(text: string, source: CommandSource, origin?: number): Promise<CommandOutcome> {
    let parsed;
    try {
      parsed = parseCommand(text);
    } catch (err) {
      const message = err instanceof DslError ? err.message : String(err);
      return { ok: false, error: `could not parse command: ${message}` };
    }
    return this.exec(parsed.id, parsed.props, source, origin);
  }

  /**
   * `origin` is who asked, carried for this execution only. It is a shallow overlay on the
   * shared context rather than a field on it, because commands genuinely overlap: a mutable
   * field would be clobbered by the next invocation while this one was still running. Absent
   * means nobody in particular asked, and the host decides who to answer.
   */
  async exec(
    id: string,
    raw: Record<string, unknown>,
    source: CommandSource,
    origin?: number,
  ): Promise<CommandOutcome> {
    const command = this.opts.registry.get(id);
    if (!command) return { ok: false, error: `unknown command "${id}"` };

    const coerced = coerceProps(command.props as PropSpecMap, raw);
    if (!coerced.ok) {
      return { ok: false, error: `invalid props for "${id}": ${coerced.errors.join('; ')}` };
    }
    const props = coerced.value;

    const ctx: CommandContext<Host> =
      origin === undefined ? this.opts.context : { ...this.opts.context, origin };
    if (command.confirm) {
      if (!ctx.confirm) {
        return { ok: false, error: `"${id}" needs confirmation, but no gate is wired` };
      }
      if (!(await ctx.confirm(`Run ${command.title}?`))) {
        return { ok: false, error: `"${id}" was declined` };
      }
    }

    // A deferring command joins the batch instead of committing; anything else mutating ends it.
    // A disposed stack defers nothing, since it no longer arms the timer that would drain it.
    const defers = Boolean(
      command.defersCommit &&
      command.mutating &&
      !command.commitsItself &&
      this.opts.committer &&
      !this.disposed,
    );

    const run = (): Promise<CommandOutcome> =>
      this.runCommand({ command, props, ctx, id, source, defers });

    // Mutating commands contend for one worktree and one `-A` commit scope, so one takes the
    // chain for the whole span from the flush through `run` to the commit. Overlapping them
    // would let one command's write land on disk inside another's commit.
    return command.mutating ? this.serialize(run) : run();
  }

  /** The part of `exec` that runs under the chain: flush, snapshot, run, snapshot, commit. */
  private async runCommand(opts: {
    command: Command<PropSpecMap, Host>;
    props: Record<string, PropValue>;
    ctx: CommandContext<Host>;
    id: string;
    source: CommandSource;
    defers: boolean;
  }): Promise<CommandOutcome> {
    const { command, props, ctx, id, source, defers } = opts;
    // Before `run` rather than before the commit: at this moment the only dirty content is the
    // deferred edits, so the flush commit contains exactly them.
    if (command.mutating && !defers) await this.flush();

    const startedAt = this.now();
    const { head, dirty } = await this.gitState();
    const seq = ++this.seq;
    // The record holds the digested props; `run` below still gets the real ones.
    const recorded = await digestProps(command.props as PropSpecMap, props);
    const base = {
      seq,
      id,
      props: recorded,
      invocation: formatCommand(id, recorded),
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
        ...(output.subject ? { subject: output.subject } : {}),
        ...(output.written ? { written: output.written } : {}),
        ...(journal && pre && post ? { undo: journal.point(pre, post) } : {}),
      };
      if (defers) {
        record.commitDeferred = true;
        this.pending.push(record);
        this.arm();
      } else {
        const commits = await this.commit(command.mutating && !command.commitsItself, record);
        if (commits.length > 0) record.commits = commits;
      }
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
   * Whether `id` would run right now, asking the command's own precondition without running it.
   *
   * There are three states rather than two. `undeclared` is the answer for a command that has no
   * check — the absence of a precondition is not permission, and reporting it as an accept would
   * claim more than the command stated. Props are coerced first, so a check sees exactly what
   * `run` would.
   *
   * Nothing here gates `exec`: a check reports on the present state, and `run` decides again.
   */
  async check(
    id: string,
    raw: Record<string, unknown>,
    origin?: number,
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
      const ctx: CommandContext<Host> =
        origin === undefined ? this.opts.context : { ...this.opts.context, origin };
      const result = await command.check(coerced.value as never, ctx);
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
   * The most recent record that changed the workspace, which is the one undo would reverse.
   *
   * Non-mutating records are skipped, so a `view.room` between two edits does not stand in the
   * way, and the stack's own undo/redo entries are skipped because they are history rather
   * than undo points. A bracketed command that changed nothing (`undo.changed === false`) is
   * skipped too: its two trees are identical, so reaching past it cannot skip over an edit. A
   * candidate without snapshots is still returned — undo names it and refuses, rather than
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
      point: target.undo,
      from: 'post',
      to: 'pre',
      done: () => this.undone.push(target),
    });
  }

  /**
   * Move the working copy forward to the record's `post` snapshot.
   *
   * This restores the post-state and never replays `invocation`: a replay is a re-run, and for
   * anything touching a model or reading changed inputs it would produce a different result
   * (`docs/history/gitUndoOptions.md` §7). The invocation stays on the record for exactly that use.
   */
  async redo(): Promise<CommandOutcome> {
    const journal = this.opts.journal;
    if (!journal) return { ok: false, error: NO_JOURNAL };
    const target = this.undone[this.undone.length - 1];
    if (!target?.undo) return { ok: false, error: 'nothing to redo' };
    return this.move({
      target,
      kind: 'redo',
      point: target.undo,
      from: 'pre',
      to: 'post',
      done: () => void this.undone.pop(),
    });
  }

  /** The shared body of undo and redo: guard, restore, record. */
  private move(opts: Move): Promise<CommandOutcome> {
    // Restoring overwrites the worktree and then commits it with `-A`, so a pending batch has to
    // land as its own commit before either of those touches the deferred edits.
    return this.serialize(async () => {
      await this.flush();
      return this.moveBody(opts);
    });
  }

  private async moveBody(opts: Move): Promise<CommandOutcome> {
    const journal = this.opts.journal!;
    const { target, kind } = opts;
    const startedAt = this.now();
    try {
      const checked = await journal.check(opts.point, opts.from);
      if (!checked.ok)
        return { ok: false, error: `cannot ${kind} ${target.invocation}: ${checked.error}` };
      const { moved, error } = await journal.restore(checked.trees, opts.point, opts.to);
      if (error !== undefined) {
        // Restore is not atomic across repos, so name the ones that moved rather than letting
        // the failure read as a no-op the caller can retry from where it started.
        const partial = moved.length > 0 ? ` (restored: ${moved.join(', ')})` : '';
        return { ok: false, error: `${kind} failed: ${error}${partial}` };
      }
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
    // Commit the restored tree as a new commit rather than moving a branch ref backwards: a
    // reset would discard the commit that is the only record of the save being undone.
    const commits = await this.commit(true, record);
    if (commits.length > 0) record.commits = commits;
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

  /**
   * Runs `body` after every mutating command already queued, and hands the next one a settled
   * chain whether this one resolved or threw.
   */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const next = this.chain.then(body);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Commit the pending batch as one commit per repo, and report what landed. Waits for a mutating
   * command already in flight, so call it from outside one: quit does, and a command that called
   * it would queue behind itself and never return.
   */
  async flushCommits(): Promise<CommitResult[]> {
    return this.serialize(() => this.flush());
  }

  /**
   * Commit what is pending and stop deferring. The host calls this on a stack it is dropping: a
   * timer that outlived one would fire against a committer whose repos have since been refilled
   * with the next project's, and commit one project's edits into another.
   *
   * The flush does not take the chain, because the one caller is inside the mutating command that
   * asked for the switch and already holds it. That command flushed before it ran, and a
   * deferring act is mutating and so cannot have started since, which is what makes the direct
   * call safe rather than merely necessary.
   */
  async dispose(): Promise<CommitResult[]> {
    this.disposed = true;
    this.cancel();
    return this.flush();
  }

  /** Restart the idle countdown, so a batch is bounded by the last act rather than the first. */
  private arm(): void {
    if (this.disposed) return;
    this.cancel();
    const fire = (): void => {
      this.idle = null;
      void this.flushCommits();
    };
    const timer = this.opts.timer;
    this.idle = timer ? timer.set(fire, BATCH_IDLE_MS) : setTimeout(fire, BATCH_IDLE_MS);
  }

  private cancel(): void {
    if (this.idle === null) return;
    const timer = this.opts.timer;
    if (timer) timer.clear(this.idle);
    else clearTimeout(this.idle as ReturnType<typeof setTimeout>);
    this.idle = null;
  }

  /**
   * Drain the batch. A second caller awaits the first rather than starting a second commit over
   * the same repos. An empty result drains as a success: `Committer` returns one both for
   * nothing to commit and for a machine with no repo at all, and keeping the batch there would
   * make it grow for the whole session. Only a throw keeps it, for the next flush to retry.
   */
  private flush(): Promise<CommitResult[]> {
    // Here rather than only in `flushCommits`, so no path leaves a timer to fire against a batch
    // that has already drained.
    this.cancel();
    if (this.flushing) return this.flushing;
    if (this.pending.length === 0) return Promise.resolve([]);
    const records = this.pending;
    this.pending = [];
    const run = (async () => {
      try {
        return (await this.opts.committer?.commitBatch(records)) ?? [];
      } catch (err) {
        this.pending = [...records, ...this.pending];
        this.opts.context.log(
          'warn',
          `commit-on-save (batch of ${records.length}) failed: ${String(err)}`,
        );
        this.report(err, records);
        return [];
      } finally {
        this.flushing = null;
      }
    })();
    this.flushing = run;
    return run;
  }

  /** Tells the host a batch is still on disk. A hook that throws must not fail the flush. */
  private report(error: unknown, records: CommandRecord[]): void {
    try {
      this.opts.onCommitError?.(error, records);
    } catch (err) {
      this.opts.context.log('warn', `commit failure not reported: ${String(err)}`);
    }
  }

  /**
   * Commit what the act left on disk, or degrade to no commit — the same rule as snapshots:
   * provenance must not be able to fail a command that already ran and already wrote.
   */
  private async commit(when: boolean, record: CommandRecord): Promise<CommitResult[]> {
    const committer = this.opts.committer;
    if (!committer || !when) return [];
    try {
      return await committer.commit(record);
    } catch (err) {
      this.opts.context.log('warn', `commit-on-save (${record.invocation}) failed: ${String(err)}`);
      return [];
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
   * Records provenance rather than driving control flow. A project need not be a git repo, so
   * failures here degrade to `{ head: null, dirty: false }` rather than failing the command.
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
