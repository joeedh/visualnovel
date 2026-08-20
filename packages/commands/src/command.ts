/**
 * The command contract. Modelled on `@vn/authoring`'s `Tool` so the two registries read as
 * siblings: a named, described, typed, gated shim over a function that already exists.
 *
 * The two differ in what they serve. A `Tool` is advertised to an LLM and gated by the
 * agent's plan/execute mode; a `Command` is the app's own vocabulary — reachable from the
 * palette, the menu bar, the DSL, and CDP — and is recorded on a stack with provenance.
 */
import type { Git } from '@vn/git';
import type { PropSpecMap, PropValue, PropsOf } from './props.js';
import type { UndoPoint } from './undo.js';

/** Where an invocation came from. Recorded on every `CommandRecord`. */
export type CommandSource = 'ui' | 'menu' | 'dsl' | 'cdp' | 'agent';

/** Everything a command may reach. `Host` is the app-specific service bundle. */
export interface CommandContext<Host = unknown> {
  /** The workspace / document-repo root the command operates on. */
  root: string;
  git: Git;
  host: Host;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * Ask the host to confirm an elevated action. Absent in bare contexts, in which case a
   * `confirm: true` command refuses rather than assuming consent (same rule as tools).
   */
  confirm?(message: string): Promise<boolean>;
  /**
   * Who asked, as an opaque number carried for the length of one execution.
   *
   * The framework never learns what it means; the desktop is the half that says it is a window
   * id, so a `view.*` effect can be answered by the window whose palette ran it. It is built as
   * a per-execution shallow overlay on the shared context precisely because commands overlap —
   * a mutable field would be clobbered by the next palette command while a `pipeline.run` was
   * still going.
   *
   * Deliberately absent from `CommandRecord`: a window index means nothing to a reader of
   * `commands.jsonl` a week later.
   */
  origin?: number;
}

/** What a command returns. Mirrors `ToolResult` minus the LLM-facing observation split. */
export interface CommandOutput {
  /** Human-readable one-liner for the history and the feed. */
  message: string;
  /** Structured payload handed back to the caller. */
  data?: unknown;
  /** Workspace-relative paths written — provenance now, undo input later. */
  written?: string[];
}

/**
 * Dotted, at least two segments, each starting lowercase: `gate.approve`, `agent.setMode`.
 * camelCase is allowed within a segment so ids can match the IPC channels they wrap.
 */
export const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export interface Command<M extends PropSpecMap = PropSpecMap, Host = any> {
  id: string;
  title: string;
  description: string;
  props: M;
  /** True if the command writes files or git history. Recorded; not yet a gate. */
  mutating: boolean;
  /** True if the command always needs explicit user confirmation, regardless of caller. */
  confirm?: boolean;
  /**
   * Whether the stack should snapshot the document tree around this command so it can be
   * undone. Only meaningful with `mutating: true`, and only for commands whose writes are
   * *documents* — generated output is content-addressed and is the task graph's business, not
   * undo's (`docs/history/gitUndoOptions.md` §6).
   */
  undoable?: boolean;
  /**
   * Set when the command's implementation owns its own commits — the agent loop commits once
   * per approved plan, and that plan is the authorial event. Commit-on-save then leaves it
   * alone rather than committing the same work twice under a second subject.
   */
  commitsItself?: boolean;
  /**
   * Would this run, and if not why? A report about *now* — never a gate on `run`, which
   * re-decides against the state it actually finds. A check that passed and a run that then
   * refuses is a race the caller is entitled to lose; a check that gated would only turn that
   * race into a state where the command cannot be reached at all.
   *
   * It **reads and does not write**, so asking is always free. Absence is not permission: a
   * command with no check reports `undeclared`, which is the honest answer.
   *
   * Only mutating commands declare one. A non-mutating command's answer is the command itself.
   */
  check?(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CheckResult>;
  run(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CommandOutput>;
}

/**
 * A precondition's answer. `note` on an accept is not decoration — it is where the check says
 * what it found (`4 task(s) ready`), which is the part worth reading before committing to work.
 */
export type CheckResult = { ok: true; note: string } | { ok: false; reason: string };

/** Identity, but it infers `M` from the literal so `run`'s props are typed at the call site. */
export function defineCommand<M extends PropSpecMap, Host>(
  command: Command<M, Host>,
): Command<M, Host> {
  return command;
}

/**
 * Bind `Host` once, keep `M` inferred: `const define = defineFor<CommandHost>()`. Naming
 * `Host` explicitly on `defineCommand` would force `M` to be written out too, and spelling
 * a prop map by hand collapses the required/optional distinction the builders encode.
 */
export function defineFor<Host>(): <M extends PropSpecMap>(
  command: Command<M, Host>,
) => Command<M, Host> {
  return (command) => command;
}

/** The outcome of one `CommandStack.exec` — never throws for command-level failure. */
export type CommandOutcome =
  | { ok: true; record: CommandRecord; data?: unknown }
  | { ok: false; error: string; record?: CommandRecord };

/**
 * One executed command. `gitHead`, `gitDirty`, `written` and `invocation` are captured for
 * provenance and debugging now, and are exactly the inputs every undo strategy in
 * `docs/history/gitUndoOptions.md` needs later.
 */
export interface CommandRecord {
  seq: number;
  id: string;
  props: Record<string, PropValue>;
  /** The DSL rendering — a copy-pasteable repro line. */
  invocation: string;
  source: CommandSource;
  mutating: boolean;
  /** Document-repo HEAD at exec time; null in an unborn repo or outside one. */
  gitHead: string | null;
  /** Whether the worktree was dirty when the command ran. */
  gitDirty: boolean;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error';
  message: string;
  written?: string[];
  error?: string;
  /**
   * Shadow snapshots taken either side of an undoable command — commit shas parked under
   * `refs/vn/undo/<seq>/`. Absent means the record is not an undo point, which is how history
   * written before undo existed stays readable. A record with `changed: false` is walked past
   * rather than reported as reversing something the author would see no trace of.
   */
  undo?: UndoPoint;
  /**
   * Commits this act produced under commit-on-save, one per repo that had something to commit.
   * Absent on a record from a stack with no committer, and on one that changed nothing.
   */
  commits?: { repo: string; sha: string }[];
  /**
   * Set on the stack's own undo/redo entries. They mutate the worktree, so they are recorded,
   * but they are history rather than undo points and are skipped when choosing a candidate.
   */
  stack?: 'undo' | 'redo';
}
