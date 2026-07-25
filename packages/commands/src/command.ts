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
   * Reserved. v1 registers nothing undoable and `CommandStack.undo` refuses — the strategy
   * survey lives in `docs/gitUndoOptions.md`.
   */
  undoable?: false;
  run(props: PropsOf<M>, ctx: CommandContext<Host>): Promise<CommandOutput>;
}

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
 * `docs/gitUndoOptions.md` needs later.
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
}
