/**
 * The one execution path for every command, and the history of what ran.
 *
 * Undo is opt-in per command and rests on content-addressed snapshots (`undo.ts`): with a journal
 * wired, a command marked `undoable` is bracketed by two captures of the document tree, and
 * undo/redo move the working copy between them. Without one, the stack behaves exactly as it did
 * before undo existed and refuses both.
 */
import { digestProps } from './digest.js';
import { formatCommand, parseCommand, DslError } from './dsl.js';
import { coerceProps, type PropSpecMap, type PropValue } from './props.js';
import type { CommandRegistry } from './registry.js';
import type { Committer, CommitResult } from './commit.js';
import type { UndoJournal } from './undo.js';
import type {
  Command,
  CommandContext,
  CommandOutcome,
  CommandRecord,
  CommandSource,
  UndoPoint,
} from './command.js';

const NO_JOURNAL = 'undo is unavailable here — no snapshot journal is wired';

/**
 * How long a batch waits for the next deferring act before committing itself. Bounds how long an
 * author who edits and then stops leaves a dirty worktree behind.
 */
export const BATCH_IDLE_MS = 1500;

/**
 * How long an open checkpoint waits for `endCheckpoint` before `failCheckpoint` runs and the
 * chain-holding gate releases on its own. Sized against the real cost driver — every
 * non-deferring command inside a checkpoint still commits individually, serialized on the
 * checkpoint's own tail, so a batch of a few hundred nodes is a few hundred real `git commit`
 * subprocesses before `endCheckpoint` can even take its `post` capture — not against IPC latency.
 */
export const CHECKPOINT_TIMEOUT_MS = 120_000;

/** A round-trippable token naming an open checkpoint. No methods, no closed-over state. */
export interface CheckpointHandle {
  readonly seq: number;
}

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

/**
 * A checkpoint between `beginCheckpoint` and `endCheckpoint`/`failCheckpoint`. Holds `this.chain`
 * for its whole span via `release`, which resolves the gate `beginCheckpoint` is awaiting inside
 * its own `serialize` turn.
 */
interface OpenCheckpoint {
  seq: number;
  shortLabel: string;
  message: string;
  /** Root-relative directory this checkpoint's snapshot is confined to. */
  scope: string;
  pre: string;
  startedAt: string;
  /** Per-checkpoint mini-chain a handle-tagged `exec()` queues onto, in arrival order. */
  tail: Promise<void>;
  /** Set once an inner command or the timeout has failed this checkpoint. */
  failed?: string;
  release: () => void;
  timeoutHandle: unknown;
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
  private openCheckpoint: OpenCheckpoint | undefined;

  constructor(private readonly opts: CommandStackOptions<Host>) {}

  /** Parse and run a DSL invocation, e.g. `gate.approve(characterId='aiko')`. */
  async execDsl(
    text: string,
    source: CommandSource,
    origin?: number,
    checkpoint?: CheckpointHandle,
  ): Promise<CommandOutcome> {
    let parsed;
    try {
      parsed = parseCommand(text);
    } catch (err) {
      const message = err instanceof DslError ? err.message : String(err);
      return { ok: false, error: `could not parse command: ${message}` };
    }
    return this.exec(parsed.id, parsed.props, source, origin, checkpoint);
  }

  /**
   * `origin` is who asked, carried for this execution only. It is a shallow overlay on the
   * shared context rather than a field on it, because commands genuinely overlap: a mutable
   * field would be clobbered by the next invocation while this one was still running. Absent
   * means nobody in particular asked, and the host decides who to answer.
   *
   * `checkpoint` routes a mutating command onto an open checkpoint's own tail instead of the
   * shared chain, so it lands inside that checkpoint's one undo point rather than getting its
   * own. A stale handle (wrong seq, or none open) is refused immediately rather than queued.
   */
  async exec(
    id: string,
    raw: Record<string, unknown>,
    source: CommandSource,
    origin?: number,
    checkpoint?: CheckpointHandle,
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

    if (!command.mutating) {
      return this.runCommand({ command, props, ctx, id, source, defers });
    }

    if (checkpoint !== undefined) {
      const oc = this.openCheckpoint;
      if (!oc || oc.seq !== checkpoint.seq) {
        return { ok: false, error: `no open checkpoint ${checkpoint.seq}` };
      }
      // Re-checked once this call's turn on the tail actually arrives, so a command queued
      // before a sibling's failure is refused rather than run against a checkpoint that has
      // since failed.
      const guarded = (): Promise<CommandOutcome> => {
        if (this.openCheckpoint !== oc || oc.failed !== undefined) {
          return Promise.resolve({ ok: false, error: `no open checkpoint ${checkpoint.seq}` });
        }
        return this.runCommand({ command, props, ctx, id, source, defers, checkpoint: oc });
      };
      const next = oc.tail.then(guarded);
      oc.tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    // Mutating commands contend for one worktree and one `-A` commit scope, so one takes the
    // chain for the whole span from the flush through `run` to the commit. Overlapping them
    // would let one command's write land on disk inside another's commit. When a checkpoint is
    // open, `this.chain` is held for its whole span (see `beginCheckpoint`), so a caller that
    // forgot the handle simply queues behind it like any other in-flight mutating command.
    return this.serialize(() => this.runCommand({ command, props, ctx, id, source, defers }));
  }

  /** The part of `exec` that runs under the chain: flush, snapshot, run, snapshot, commit. */
  private async runCommand(opts: {
    command: Command<PropSpecMap, Host>;
    props: Record<string, PropValue>;
    ctx: CommandContext<Host>;
    id: string;
    source: CommandSource;
    defers: boolean;
    checkpoint?: OpenCheckpoint;
  }): Promise<CommandOutcome> {
    const { command, props, ctx, id, source, defers, checkpoint } = opts;
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

    // The snapshot is taken before the command runs, because a command that fails partway
    // through can still have written files, and only the pre-state describes where it started.
    // A command run inside a checkpoint skips its own bracket entirely: the checkpoint's own
    // pre/post pair covers the whole group.
    const journal =
      !checkpoint && command.undoable && command.mutating ? this.opts.journal : undefined;
    const pre = await this.capture(journal, seq, 'pre');

    try {
      const output = await command.run(props as never, ctx);
      const post = await this.capture(journal, seq, 'post');
      if (checkpoint && output.written) this.checkWrittenScope(checkpoint, output.written);
      const record: CommandRecord = {
        ...base,
        finishedAt: this.now(),
        status: 'ok',
        message: output.message,
        ...(output.subject ? { subject: output.subject } : {}),
        ...(output.written ? { written: output.written } : {}),
        ...(journal && pre && post ? { undo: journal.point(pre, post) } : {}),
        ...(checkpoint ? { checkpoint: checkpoint.seq } : {}),
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
        ...(checkpoint ? { checkpoint: checkpoint.seq } : {}),
      };
      await this.record(record);
      if (checkpoint) await this.failCheckpoint(checkpoint, error);
      return { ok: false, error, record };
    }
  }

  /**
   * Run several commands as one undo point. `scope` is a root-relative directory the checkpoint's
   * snapshot is confined to — a fact about what *this* checkpoint's commands are expected to
   * write, decided by whoever opens it, not a fact about a whole command namespace.
   *
   * Occupies `this.chain` from when this resolves until `endCheckpoint`/the timeout releases it,
   * so every other mutating command queues behind it exactly like any other in-flight one.
   */
  async beginCheckpoint(
    shortLabel: string,
    message: string,
    scope: string,
  ): Promise<CheckpointHandle> {
    if (this.openCheckpoint) throw new Error('a checkpoint is already open');
    const journal = this.opts.journal;
    if (!journal) throw new Error(NO_JOURNAL);

    let resolveHandle!: (handle: CheckpointHandle) => void;
    let rejectHandle!: (err: unknown) => void;
    const handle = new Promise<CheckpointHandle>((resolve, reject) => {
      resolveHandle = resolve;
      rejectHandle = reject;
    });

    // Not awaited here: this occupies `this.chain` for the checkpoint's whole span via the gate
    // below, while `handle` itself resolves as soon as setup finishes, well before the gate
    // opens. The `try`/`catch` keeps this async body's own promise settled (never rejected), so
    // the unawaited `serialize` call cannot produce an unhandled rejection.
    void this.serialize(async () => {
      try {
        await this.flush();
        const seq = ++this.seq;
        const pre = await journal.captureScoped(scope, seq);
        if (pre === null) {
          rejectHandle(new Error(`no ${scope} to checkpoint`));
          return;
        }

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.openCheckpoint = {
          seq,
          shortLabel,
          message,
          scope,
          pre,
          startedAt: this.now(),
          tail: Promise.resolve(),
          release,
          timeoutHandle: this.armCheckpointTimeout(seq),
        };
        resolveHandle({ seq });
        await gate;
      } catch (err) {
        rejectHandle(err);
      }
    });

    return handle;
  }

  /**
   * Close a checkpoint, appending one aggregate `stack.checkpoint` record covering every command
   * that ran inside it. If an inner command already failed, the rollback in `failCheckpoint` has
   * already run; this just reports it and releases the chain.
   */
  async endCheckpoint(handle: CheckpointHandle): Promise<CommandOutcome> {
    const oc = this.openCheckpoint;
    if (!oc || oc.seq !== handle.seq) {
      return { ok: false, error: `no open checkpoint ${handle.seq}` };
    }
    // Lets a command already queued on the tail run or be refused before this closes.
    await oc.tail;
    if (oc.failed !== undefined) {
      const error = oc.failed;
      this.closeCheckpoint(oc);
      return { ok: false, error };
    }

    const journal = this.opts.journal!;
    // The pinning capture, not `currentTreeScoped`: it holds the tree under this checkpoint's
    // own `seq` in `journal.taken`, the same way `pre` was pinned, so the `prune()` call right
    // below cannot collect it out from under the record that is about to name it.
    const post = await journal.captureScoped(oc.scope, oc.seq);
    if (post === null) {
      await this.failCheckpoint(oc, `no ${oc.scope} to checkpoint`);
      const error = oc.failed!;
      this.closeCheckpoint(oc);
      return { ok: false, error };
    }
    this.prune(journal);

    const { head, dirty } = await this.gitState();
    const record: CommandRecord = {
      seq: ++this.seq,
      id: 'stack.checkpoint',
      props: {},
      // Synthetic and non-replayable, for `commands.jsonl` consistency; `label` is what the UI
      // shows in its place.
      invocation: `stack.checkpoint(seq=${oc.seq})`,
      label: oc.shortLabel,
      source: 'ui',
      mutating: true,
      gitHead: head,
      gitDirty: dirty,
      startedAt: oc.startedAt,
      finishedAt: this.now(),
      status: 'ok',
      message: oc.message,
      undo: journal.point(oc.pre, post),
    };
    await this.record(record);
    this.closeCheckpoint(oc);
    return { ok: true, record };
  }

  /**
   * The one rollback path, used by both an inner-command failure and a timeout. Restores to
   * `openCheckpoint.pre` with no drift check: the snapshot is scoped to `openCheckpoint.scope`,
   * so it structurally cannot contain a path outside it, and there is nothing an out-of-band
   * write elsewhere could do to it.
   */
  private async failCheckpoint(openCheckpoint: OpenCheckpoint, error: string): Promise<void> {
    if (openCheckpoint.failed !== undefined) return;
    openCheckpoint.failed = error;
    const { seq, shortLabel, scope, pre } = openCheckpoint;
    const journal = this.opts.journal;

    if (journal) {
      try {
        const current = await journal.currentTreeScoped(scope);
        if (current !== null && current !== pre) {
          const restored = await journal.restoreScoped(
            scope,
            current,
            journal.point(pre, current),
            'pre',
          );
          if (restored.error) {
            this.opts.context.log(
              'warn',
              `checkpoint rollback (seq ${seq}) failed: ${restored.error}`,
            );
          }
        }
      } catch (err) {
        this.opts.context.log('warn', `checkpoint rollback (seq ${seq}) failed: ${String(err)}`);
      }
    }

    const { head, dirty } = await this.gitState();
    const record: CommandRecord = {
      seq: ++this.seq,
      id: 'stack.checkpointRollback',
      props: { checkpoint: seq },
      invocation: `stack.checkpointRollback(seq=${seq})`,
      source: 'ui',
      mutating: true,
      checkpoint: seq,
      gitHead: head,
      gitDirty: dirty,
      startedAt: this.now(),
      finishedAt: this.now(),
      status: 'error',
      message: `Rolled back "${shortLabel}": ${error}`,
      error,
    };
    // The same two calls `moveBody` makes for an ordinary restore: the rollback's commit lands
    // in `commands.jsonl` with a reason attached, and retires any commit an inner command already
    // made individually before the failure.
    const commits = await this.commit(true, record);
    if (commits.length > 0) record.commits = commits;
    await this.record(record);

    // A deferred commit from this checkpoint must not survive to be flushed under a message
    // describing content the rollback just erased from disk.
    this.pending = this.pending.filter((r) => r.checkpoint !== seq);

    if (journal) this.prune(journal);
  }

  /** Runs `failCheckpoint` then forces the same close `endCheckpoint` would run. */
  private timeoutCheckpoint(seq: number): void {
    const oc = this.openCheckpoint;
    if (!oc || oc.seq !== seq) return;
    void (async () => {
      await oc.tail;
      if (this.openCheckpoint !== oc) return;
      if (oc.failed === undefined) {
        await this.failCheckpoint(oc, `checkpoint timed out after ${CHECKPOINT_TIMEOUT_MS}ms`);
      }
      this.closeCheckpoint(oc);
    })();
  }

  private armCheckpointTimeout(seq: number): unknown {
    const fire = (): void => this.timeoutCheckpoint(seq);
    const timer = this.opts.timer;
    return timer ? timer.set(fire, CHECKPOINT_TIMEOUT_MS) : setTimeout(fire, CHECKPOINT_TIMEOUT_MS);
  }

  /** Clears the checkpoint's timeout, clears `openCheckpoint`, and releases the held chain. */
  private closeCheckpoint(oc: OpenCheckpoint): void {
    const timer = this.opts.timer;
    if (timer) timer.clear(oc.timeoutHandle);
    else clearTimeout(oc.timeoutHandle as ReturnType<typeof setTimeout>);
    if (this.openCheckpoint === oc) this.openCheckpoint = undefined;
    oc.release();
  }

  /**
   * Logs rather than refuses: catches a future command that violates its checkpoint's declared
   * scope, without relying on `written` for anything the failure path needs (it is only reliable
   * on success).
   */
  private checkWrittenScope(checkpoint: OpenCheckpoint, written: string[]): void {
    const prefix = `${checkpoint.scope}/`;
    for (const path of written) {
      if (path !== checkpoint.scope && !path.startsWith(prefix)) {
        this.opts.context.log(
          'warn',
          `checkpoint ${checkpoint.seq} (${checkpoint.scope}) wrote outside its scope: ${path}`,
        );
        return;
      }
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
      if (record.checkpoint !== undefined) continue;
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
      undoLabel: undoable ? (undo!.label ?? undo!.invocation) : null,
      redoLabel: redo ? (redo.label ?? redo.invocation) : null,
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
   * anything touching a model or reading changed inputs it would produce a different result. The
   * invocation stays on the record for exactly that use.
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
    let restored: string[] = [];
    try {
      const checked = await journal.check(opts.point, opts.from);
      if (!checked.ok)
        return { ok: false, error: `cannot ${kind} ${target.invocation}: ${checked.error}` };
      const { error, changed } = await journal.restore(checked.tree, opts.point, opts.to);
      restored = changed;
      // A restore that failed part way through leaves the worktree between the two trees, so the
      // failure is reported rather than thrown: a caller told nothing happened would be wrong.
      if (error !== undefined) return { ok: false, error: `${kind} failed: ${error}` };
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
      message: `${kind === 'undo' ? 'Undid' : 'Redid'} ${target.label ?? target.invocation}.`,
      // What the restore moved, so a surface following a document hears about an undo on the same
      // channel as the command it is undoing. Absent rather than empty where it moved nothing.
      ...(restored.length > 0 ? { written: restored } : {}),
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
  ): Promise<string | null> {
    if (!journal) return null;
    try {
      return await journal.capture(seq);
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
    try {
      journal.prune();
    } catch (err) {
      this.opts.context.log('warn', `undo snapshots not pruned: ${String(err)}`);
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
