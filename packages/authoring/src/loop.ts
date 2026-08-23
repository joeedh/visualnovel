/**
 * The conversation loop, plan-mode state machine, and permission gate (authoring-agent
 * plan §6.4, §7). The loop is written against the `AgentBackend` seam so the tool-call
 * protocol can change without touching policy. Policy lives here, deterministically:
 *
 * - plan mode (read-only): only `mutating: false` tools dispatch; the gate rejects
 *   mutating tools and tells the model to `propose_plan` first.
 * - execute mode (read-write): entered only after the user approves a proposed plan.
 *   Mutating tools dispatch; `git_commit` is blocked while error-severity diagnostics
 *   remain, matching "block commit on hard errors, warn on soft".
 * - always-confirm: a `confirm: true` tool (revert/restore) routes through the
 *   permission gate regardless of mode.
 *
 * Control tools (`propose_plan`, `ask_user`, `ask_choice`) are handled by the loop, not the
 * registry — they drive the state machine rather than touch the workspace.
 */
import { z } from 'zod';
import { budgetTokens, charge, DEFAULT_BUDGET, type BudgetChoice } from '@vn/types';
import { RetryableProviderError } from '@vn/util';
import { faultKind, type FaultKind } from '@vn/providers';
import type {
  AgentAction,
  AgentBackend,
  AgentMessage,
  AgentTurn,
  CacheVerdict,
  ToolSpec,
} from './backend.js';
import { joinSections, type SystemSection } from './context.js';
import {
  createRegistry,
  describeToolParams,
  jsonSchemaOf,
  type ReadLedger,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './tools.js';

/** The two states of the plan/permission machine. */
export type AgentMode = 'plan' | 'execute';

/** A structured plan the agent proposes before it is allowed to make edits. */
export interface Plan {
  summary: string;
  steps: string[];
  files: string[];
  risks?: string[];
}

/** The outcome of asking the user to approve a plan. */
export interface PlanDecision {
  approved: boolean;
  /** Optional feedback fed back to the agent when a plan is rejected. */
  feedback?: string;
}

/**
 * The host's say in anything irreversible: approving a plan (the gate into execute mode),
 * confirming an always-confirm action, and answering a clarifying question. The REPL (M4)
 * implements this against the terminal; tests implement it with scripted answers.
 */
export interface Permission {
  approvePlan(plan: Plan): Promise<PlanDecision>;
  confirmAction(tool: string, args: unknown): Promise<boolean>;
  /**
   * Put a form to the author and get one answer per question, positionally. {@link answersFor}
   * pads a short answer list and truncates a long one, so a host that miscounts cannot hang the
   * turn that is waiting on the answers.
   */
  ask(form: readonly AskQuestion[]): Promise<string[]>;
}

/**
 * One question of an ask form.
 *
 * `choices` is a shortlist offered with the question rather than a second kind of question,
 * because the answer is a string either way: the list only shapes how the question is presented.
 * The author may always type something that is not on it, and the agent is told verbatim what
 * they said. A host that ignores the list asks the question as plain text, which is degraded but
 * still correct.
 */
export interface AskQuestion {
  question: string;
  /** A shortlist to pick from rather than type. Absent or empty means free text. */
  choices?: string[];
  /** Whether more than one may be picked. Meaningless without `choices`. */
  multi?: boolean;
}

/**
 * A call to the model that failed, as the host is told about it.
 *
 * `attempt` counts the failures of this step, so `1` is the first thing that went wrong and
 * anything higher means the attempts the host last granted are spent. `waitMs` is what the loop
 * would wait on its own — the provider's `retry-after` where it sent one, and an exponential
 * backoff where it did not.
 */
export interface ApiFailure {
  message: string;
  /** Whether another attempt could plausibly get a different answer: a 429, a 5xx, a dead socket. */
  transient: boolean;
  /**
   * A finer version of the same judgement: the `transient` kind matches the boolean above, and
   * the other three kinds split what the boolean lumps together as terminal. A host offers
   * different recovery for a rejected key than for a rejected body, and this field tells them
   * apart.
   */
  kind: FaultKind;
  attempt: number;
  waitMs: number;
}

/**
 * What the host wants done about a failed call to the model.
 *
 * There is deliberately no `switch model` option: the loop knows nothing about models, and a
 * host that does can swap the backend itself ({@link Agent.setBackend}) before answering `retry`.
 * The next attempt re-reads the backend field, so the swap takes effect.
 */
export type ApiRecovery =
  | {
      do: 'retry';
      /** How many more attempts, before the host is asked again. */
      times: number;
      /**
       * Wait this long before each of them, instead of the loop's own backoff and instead of
       * anything the provider asked for. Absent leaves both in charge, which is the usual case.
       */
      waitMs?: number;
    }
  /** Give up: the error leaves `run` and the caller reports it. */
  | { do: 'stop' };

/** A streamed event describing one thing the loop did (for the REPL / test assertions). */
export type AgentEvent =
  | { type: 'message'; text: string }
  | { type: 'tool'; tool: string; args: unknown; result: ToolResult }
  | { type: 'plan'; plan: Plan; decision: PlanDecision }
  | { type: 'mode'; mode: AgentMode }
  // `args` carries the refused call's arguments when there were any. A call the schema refused
  // never ran, so no `tool` event exists for it — without the arguments here, the refusal would
  // name a field the reader cannot see.
  | { type: 'blocked'; tool: string; reason: string; args?: unknown }
  // What one step cost, emitted only when the provider reported it, so a host summing these
  // shows a real total or none. The cache split is carved out of `input`, and is absent when the
  // provider said nothing (not the same as a cache miss); `cacheEstimated` marks a matched-prefix
  // count rather than a billed one — Gemini's implicit cache.
  // `verdict` says what this call did to the prompt cache, and is present only where the backend's
  // figures can be compared across calls. Absent means the question was not answerable.
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheEstimated?: boolean;
      verdict?: CacheVerdict;
    }
  // Progress of a model call that is failing. `failed` means one attempt is gone and the host is
  // about to be asked; `retrying` means attempt `attempt` of `of` is about to be made and is the
  // only phase to show a counter for; `recovered` and `gaveup` both end the sequence, so a
  // surface showing either state clears on both. On those two, `attempt` is how many failed.
  | {
      type: 'api';
      phase: 'failed' | 'retrying' | 'recovered' | 'gaveup';
      attempt: number;
      of: number;
      message: string;
      waitMs?: number;
    }
  | { type: 'final'; text: string };

/** The result of a single `run(userInput)` turn-of-conversation. */
export interface RunResult {
  final: string;
  mode: AgentMode;
  events: AgentEvent[];
  /**
   * True when the turn ended because {@link Agent.stop} cut it short. A stop that arrives while the
   * model is writing its last reply does not set this: the turn concluded on its own, and a caller
   * that reads its own request flag instead would report a finished answer as an abandoned one.
   */
  stopped?: boolean;
}

/** Everything the agent needs to drive a conversation. */
export interface AgentOptions {
  backend: AgentBackend;
  ctx: ToolContext;
  permission: Permission;
  system: string;
  /** Tool registry; defaults to all built-in tools. */
  registry?: Map<string, Tool>;
  /** Starting mode; defaults to plan (read-only). */
  mode?: AgentMode;
  /**
   * What one `run` may spend before the agent is told to wrap up, in non-cached tokens.
   * Defaults to {@link DEFAULT_BUDGET}; `unlimited` removes the ceiling but not the backstop.
   */
  budget?: BudgetChoice;
  /**
   * The runaway backstop, in steps. Defaults to {@link MAX_ITERATIONS}. Not a policy knob — a
   * host that wants a turn to stop sooner sets `budget`; this is only what catches a loop the
   * meter cannot see, because the backend reports no usage.
   */
  maxIterations?: number;
  /**
   * Whether tools outside {@link ALWAYS_LOADED} are advertised as deferred. Defaults to true.
   * Deferral pays for itself over a large catalog, where the unloaded schemas buy back real
   * context. A host with a handful of tools sets this to false: deferring them saves nothing, and
   * on the native path it hides tools the prompt orders the model to call behind tool search.
   */
  deferTools?: boolean;
  /** Optional live event sink (the REPL renders these as they happen). */
  onEvent?: (event: AgentEvent) => void;
  /**
   * What to do when the call to the model fails. When this is absent the error leaves `run` and
   * the caller reports it. A host that implements it can offer the author the choice instead
   * (retry, or swap the backend and retry) without the loop knowing anything about providers.
   */
  onApiError?: (failure: ApiFailure) => Promise<ApiRecovery>;
}

/**
 * The most questions one form may hold. The author can do nothing else while a form is up, so a
 * model that wants more than this should go and read the project instead of interviewing the
 * author.
 */
const MAX_ASK_QUESTIONS = 4;

const CONTROL_TOOLS: ToolSpec[] = [
  {
    name: 'propose_plan',
    description:
      'Propose a plan and request approval. args: {summary, steps[], files[], risks?[]}. ' +
      'On approval you switch to execute mode and may apply edits; on rejection you stay in plan mode.',
    mutating: false,
  },
  {
    name: 'ask_user',
    description: 'Ask the user a clarifying question and receive their answer. args: {question}',
    mutating: false,
  },
  {
    name: 'ask_choice',
    description:
      'Ask the user a question and offer a shortlist of answers. args: {question, choices[], multi?} ' +
      `for one question, or {questions: [{question, choices?[], multi?}, …]} for up to ${MAX_ASK_QUESTIONS} ` +
      'at once — the author pages through those with Back/Next and submits them together, so ask ' +
      'everything you need to settle in one call rather than parking the turn once per question. ' +
      'Inside a form a question may leave out its choices and be answered in the author’s own ' +
      'words, so an open question does not have to cost a second turn. ' +
      'Prefer this over ask_user whenever the sensible answers can be listed — it is far less work ' +
      'to answer. The user may still type something that is not on the list, or say they would ' +
      'rather talk it through; either way you get their answer verbatim.',
    mutating: false,
  },
];

/**
 * The tools sent in full on every request; the rest are `defer`red and the model searches for
 * them. These six are the ones a turn can need before it has had a chance to search: the three
 * control tools it must always be able to reach, and the three it opens an unfamiliar project
 * with. The list is static, so the catalog it produces is byte-identical between turns.
 */
const ALWAYS_LOADED = new Set([
  'propose_plan',
  'ask_user',
  'ask_choice',
  'read_file',
  'search',
  'list_workspace',
]);

/**
 * The runaway backstop, and deliberately not a policy — the policy is the token budget. It has to
 * exist because a backend that reports no usage (a mock, a provider without receipts) spends zero
 * against any budget and would otherwise loop until the process died. `unlimited` removes the
 * budget ceiling only; the backstop still applies.
 */
const MAX_ITERATIONS = 200;

/** Where a retry's own backoff starts and where it stops growing. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;

/**
 * The backstop on retrying one step. Not a policy knob — the policy is whatever the host answers
 * — but without it a host that keeps answering `retry` could retry a permanent failure
 * indefinitely.
 */
const MAX_API_ATTEMPTS = 50;

/**
 * How long to wait before attempt `attempt` of the same step, in ms.
 *
 * `after` is what the provider itself asked for and wins outright, because the response is the
 * only thing that knows when a limit resets. Otherwise it is the doubling every vendor's guidance
 * describes, capped so a long grant cannot end up sleeping for an hour.
 *
 * Deliberately without the jitter that guidance also calls for. Jitter keeps a fleet of clients
 * from retrying in lockstep, and there is only one conversation here, so it would only make the
 * wait impossible for a test to pin down.
 */
export function apiBackoffMs(attempt: number, after?: number): number {
  if (after !== undefined && after > 0) return Math.min(RETRY_CAP_MS, after);
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** What the provider said to wait, where the backend kept it. */
function retryAfterOf(err: unknown): number | undefined {
  return err instanceof RetryableProviderError ? err.retryAfterMs : undefined;
}

function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the model is told as the budget nears its ceiling. Carries the instruction to wrap up, not just the number. */
function budgetWarning(left: number): string {
  return (
    `BUDGET: about ${left.toLocaleString()} tokens remain this turn. Stop starting new work. ` +
    'Finish and commit what is in progress, then reply telling the author exactly what landed ' +
    'and what is left.'
  );
}

/** The mode as stated to the model. A complete sentence, so filing it again restates the whole rule. */
function modeMessage(mode: AgentMode): string {
  return mode === 'plan'
    ? 'MODE: plan (read-only). Mutating tools are blocked until a plan is approved. This ' +
        'supersedes any earlier mode message.'
    : 'MODE: execute (read-write). Mutating tools will run. This supersedes any earlier mode ' +
        'message.';
}

/** How a rewritten system-prompt section is handed over mid-conversation. */
function supersedeMessage(section: SystemSection): string {
  return (
    `The "${section.name}" section of the system prompt has been rewritten since this ` +
    'conversation started. What follows replaces that section in full — read it instead of the ' +
    `version above.\n\n${section.text}`
  );
}

/**
 * How a tool call reads back in a text transcript. The arguments are in it because a transcript
 * that says only which tool ran leaves the model re-deriving what it asked for — and on the text
 * path this is exactly the JSON it emitted.
 */
function callRecord(action: AgentAction): string {
  return JSON.stringify({ tool: action.tool, args: action.args });
}

/** How a section that has since disappeared is withdrawn. */
function withdrawMessage(name: string): string {
  return (
    `The "${name}" section of the system prompt no longer exists. Disregard the version above; ` +
    'nothing replaces it.'
  );
}

const planSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  risks: z.array(z.string()).optional(),
});

const askSchema = z.object({ question: z.string().min(1) });

// At least two choices: a "shortlist" of one is a leading question, and disagreeing with it
// would force the author into the text box.
const oneChoiceSchema = z.object({
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2),
  multi: z.boolean().default(false),
});

/**
 * A question inside a form may omit its shortlist. Asked on its own, an open question belongs
 * to `ask_user` — but a form parks the turn once either way, so making the model ask the listed
 * questions here and the open one separately would cost a second turn to learn nothing extra.
 */
const formItemSchema = oneChoiceSchema.extend({
  choices: oneChoiceSchema.shape.choices.optional(),
});

/**
 * Both shapes are accepted: one question is the common case and should not have to be wrapped
 * in an array to be asked.
 */
const choiceSchema = z.union([
  oneChoiceSchema,
  z.object({ questions: z.array(formItemSchema).min(1).max(MAX_ASK_QUESTIONS) }),
]);

/**
 * The answers, adjusted to match the form: a short answer list leaves the rest unanswered, and a
 * long one has the surplus dropped. Neither case throws — the model reads the answers as prose,
 * and an empty string reads as "no answer".
 */
export function answersFor(form: readonly AskQuestion[], given: readonly string[]): string[] {
  return form.map((_, i) => given[i] ?? '');
}

/**
 * What the model is told the author said. One question keeps the bare sentence it has always had;
 * a form repeats each question above its answer, because "yes, no, the second one" is unreadable
 * against a list of questions the model asked several steps ago.
 */
export function askObservation(form: readonly AskQuestion[], answers: readonly string[]): string {
  if (form.length === 1) return `User answered: ${answers[0] ?? ''}`;
  const said = (text: string): string => (text.trim() === '' ? '(no answer)' : text.trim());
  const lines = form.map((q, i) => `${i + 1}. ${q.question}\n   ${said(answers[i] ?? '')}`);
  return `User answered:\n${lines.join('\n')}`;
}

/**
 * Drives a ReAct conversation: the backend proposes one action per step, the loop gates
 * and dispatches it, and the observation feeds the next step. Conversation state persists
 * across `run` calls so a REPL can keep talking to the same `Agent`.
 */
export class Agent {
  private backend: AgentBackend;
  private readonly ctx: ToolContext;
  private readonly permission: Permission;
  private system: string;
  private readonly registry: Map<string, Tool>;
  private budget: number;
  /** Which choice {@link budget} came from, quoted in the message a budget-exhausted turn ends with. */
  private budgetChoice: BudgetChoice;
  private readonly maxIterations: number;
  private readonly deferTools: boolean;
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly onApiError?: (failure: ApiFailure) => Promise<ApiRecovery>;
  private readonly messages: AgentMessage[] = [];
  /** Workspace-relative paths the agent has written since the last commit (commit scope). */
  private readonly editedPaths = new Set<string>();
  /** What the agent has been shown of each file this conversation — `edit_file`'s staleness check. */
  private readonly seen: ReadLedger = new Map();
  private mode: AgentMode;
  /** The mode the transcript last stated. Differs from {@link mode} exactly when a mode message
   *  still needs to be filed. */
  private filedMode?: AgentMode;
  /** The system-prompt sections this conversation was started with, by name. */
  private sections = new Map<string, string>();
  /** System messages owed to the model, filed after the next user turn (never before one). */
  private readonly pendingSystem: string[] = [];
  /** Set by {@link stop}, cleared when a turn starts. Read between steps, never inside one. */
  private stopped = false;

  constructor(opts: AgentOptions) {
    this.backend = opts.backend;
    this.ctx = {
      ...opts.ctx,
      // The ledger belongs to the conversation, so the agent owns it rather than the host: a
      // context passed in fresh each turn would forget every read between one turn and the next.
      seen: this.seen,
      // The author's own turns, read live rather than copied: a tool that asks what they said
      // must see what they said this turn, not what the context held when the agent was built.
      said: () =>
        this.messages
          .filter((m) => m.role === 'user' && typeof m.content === 'string')
          .map((m) => m.content as string),
      // The confirmation channel tools use for script-bearing skills, routed to the permission
      // gate unless the host already supplied one.
      confirm:
        opts.ctx.confirm ??
        ((message: string) => opts.permission.confirmAction('run_skill', { message })),
    };
    this.permission = opts.permission;
    this.system = opts.system;
    this.registry = opts.registry ?? createRegistry();
    this.mode = opts.mode ?? 'plan';
    this.budgetChoice = opts.budget ?? DEFAULT_BUDGET;
    this.budget = budgetTokens(this.budgetChoice);
    this.maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    this.deferTools = opts.deferTools ?? true;
    this.onEvent = opts.onEvent;
    this.onApiError = opts.onApiError;
  }

  /** The mode the machine is currently in. */
  get currentMode(): AgentMode {
    return this.mode;
  }

  /**
   * Force the plan/execute mode directly (e.g. the REPL's Shift-Tab toggle). This bypasses
   * the plan-approval gate, so switching to `execute` lets the agent apply edits without a
   * formally approved plan — a deliberate manual override of the default flow.
   */
  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  /** What one turn may spend. The loop reads it each step, so a change lands mid-turn too. */
  setBudget(choice: BudgetChoice): void {
    this.budgetChoice = choice;
    this.budget = budgetTokens(choice);
  }

  /** The ceiling currently bound. */
  get currentBudget(): BudgetChoice {
    return this.budgetChoice;
  }

  /**
   * Reset the conversation (the `/clear` command): drop the transcript and the tracked edit
   * set, and return to plan mode. Files on disk and git history are untouched — only the
   * agent's in-memory context is cleared.
   */
  clear(): void {
    this.messages.length = 0;
    this.editedPaths.clear();
    this.seen.clear();
    this.mode = 'plan';
    // The transcript is gone, so no mode or section has been stated to it; the next
    // `refreshSystem` rebuilds the prompt outright instead of filing supersede messages.
    this.filedMode = undefined;
    this.pendingSystem.length = 0;
    // The backend survives the clear, so anything it remembers about the previous prefix would be
    // compared against a conversation that no longer exists
    this.backend.reset?.();
  }

  /**
   * End the turn in progress after the step it is on. A tool call already dispatched still
   * finishes and its observation is still recorded: the transcript is what the next turn reads,
   * and a hole in it is worse than one step the author did not want.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Swap the model backend mid-session (e.g. after `/model` or `/effort`). Conversation
   * history, mode, and tracked edits are preserved — only the next turn's model changes.
   */
  setBackend(backend: AgentBackend): void {
    this.backend = backend;
  }

  /**
   * Replace the system message outright. The new-conversation path: every byte behind it is
   * invalidated, which is free before there is a transcript and expensive after.
   */
  setSystem(system: string): void {
    this.system = system;
  }

  /**
   * Bring the system prompt up to date without rewriting it. The project map inside it is a
   * snapshot of a file, so an agent that outlives a rewrite of that file — which `update_context`
   * and the desktop's own commands both do — would otherwise keep quoting the version it was
   * built with.
   *
   * On an empty transcript that means replacing the prompt; on a live one it means filing each
   * changed section as a message that supersedes it by name, because the prompt is the front of
   * the cached prefix and appending is the only edit that keeps the rest of it.
   */
  refreshSystem(sections: SystemSection[]): void {
    if (this.messages.length === 0) {
      this.system = joinSections(sections);
      this.sections = new Map(sections.map((s) => [s.name, s.text]));
      return;
    }
    const seen = new Set<string>();
    for (const section of sections) {
      seen.add(section.name);
      if (this.sections.get(section.name) === section.text) continue;
      this.pendingSystem.push(supersedeMessage(section));
      this.sections.set(section.name, section.text);
    }
    for (const name of [...this.sections.keys()]) {
      if (seen.has(name)) continue;
      this.pendingSystem.push(withdrawMessage(name));
      this.sections.delete(name);
    }
  }

  /**
   * The tools this agent can call, as names and descriptions. A host may hand in a registry of its
   * own, so anything reporting what the agent could reach reads it from here rather than from the
   * built-in list.
   */
  get tools(): { name: string; description: string }[] {
    return [...this.registry.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  /**
   * The tool catalog advertised to the backend (registry + control tools), each flagged for
   * whether it may be deferred. Derived from a static list and the registry's own order, so two
   * turns of one conversation produce byte-identical catalogs — the prefix everything else caches
   * behind. A host that set `deferTools: false` gets the same catalog with no flags on it.
   */
  private toolSpecs(): ToolSpec[] {
    const fromRegistry = [...this.registry.values()].map((t) => {
      const schema = jsonSchemaOf(t.args);
      return {
        name: t.name,
        description: t.description,
        mutating: t.mutating,
        parameters: describeToolParams(t.args),
        ...(schema ? { schema } : {}),
      };
    });
    const all = [...fromRegistry, ...CONTROL_TOOLS];
    if (!this.deferTools) return all;
    return all.map((t) => ({
      ...t,
      ...(ALWAYS_LOADED.has(t.name) ? {} : { defer: true }),
    }));
  }

  /**
   * Answer any `tool_use` the transcript left hanging. A crash between the assistant message and
   * its observations — the process died, an old build let a tool's throw escape the loop — leaves
   * calls no `tool_result` answers, and a native API refuses the whole conversation from then on:
   * every later turn fails with the same 400. Synthesizing the missing answers here, before the
   * new user message, is what lets an already-damaged thread carry on.
   */
  private repairDanglingCalls(): void {
    const last = this.messages[this.messages.length - 1];
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant || !Array.isArray(lastAssistant.content)) return;
    // Only a trailing assistant turn can be owed answers; anything older was already replied
    // to (or the API would have refused at the time). `last` may be one of its observations.
    if (last !== lastAssistant && last?.role !== 'observation') return;
    const asked = lastAssistant.content
      .filter(
        (block): block is { type: string; id: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'tool_use' &&
          typeof (block as { id?: unknown }).id === 'string',
      )
      .map((block) => block.id);
    const from = this.messages.indexOf(lastAssistant);
    const answered = new Set(
      this.messages
        .slice(from + 1)
        .filter((m) => m.role === 'observation' && m.toolUseId)
        .map((m) => m.toolUseId),
    );
    for (const id of asked) {
      if (answered.has(id)) continue;
      this.messages.push({
        role: 'observation',
        content:
          'Error: this tool call was interrupted before it could report a result. It may have ' +
          'partially applied. Re-read the affected file(s) to see what is actually on disk ' +
          'before retrying or continuing.',
        toolUseId: id,
      });
    }
  }

  /**
   * Run one user turn to completion (a final message), driving tool calls in between.
   *
   * `focus` is what the host knew when the turn started — the scene on screen, typically. It is
   * filed as a `context` message ahead of the user's, so "rewrite this line" has a referent; a
   * host that knows nothing passes nothing, and the transcript reads exactly as it did before.
   */
  async run(userInput: string, focus?: string): Promise<RunResult> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      this.onEvent?.(event);
    };

    this.repairDanglingCalls();
    if (focus) this.messages.push({ role: 'context', content: focus });
    this.messages.push({ role: 'user', content: userInput });
    // Filed after the user's message, never before it: a system message may not open a
    // conversation and must follow a user turn. Sections first, mode last, so policy reads last.
    for (const content of this.pendingSystem.splice(0)) {
      this.messages.push({ role: 'system', content });
    }
    if (this.filedMode !== this.mode) {
      this.messages.push({ role: 'system', content: modeMessage(this.mode) });
      this.filedMode = this.mode;
    }
    const tools = this.toolSpecs();
    this.stopped = false;
    let spent = 0;
    let warned = false;

    for (let step = 0; step < this.maxIterations; step++) {
      // Between steps, so a stop lands after the tool in flight rather than during it.
      if (this.stopped) {
        const text = 'Stopped at your request.';
        this.messages.push({ role: 'assistant', content: text });
        emit({ type: 'final', text });
        return { final: text, mode: this.mode, events, stopped: true };
      }

      // The same rule `stop()` follows, for the same reason: a budget exhausted mid-reply still
      // dispatches every call in that reply, because a `tool_use` the transcript never answers
      // is a request the API will refuse to continue.
      if (spent >= this.budget) return this.ranOut(this.spentSentence(spent), emit, events);

      const turn = await this.nextTurn(tools, emit);
      // Charged before the narration is read: the call is paid for whether or not it said
      // anything useful.
      if (turn.usage) {
        spent += charge(turn.usage);
        emit({
          type: 'usage',
          ...turn.usage,
          ...(turn.cacheVerdict ? { verdict: turn.cacheVerdict } : {}),
        });
      }

      const actions = turn.actions ?? [];
      // One assistant message per step. Uses `raw` when the provider sent blocks, because echoing
      // them back unmodified is the contract. Otherwise files the narration, with each call as the
      // JSON the model emitted so the next turn can read what it asked for.
      const narration: string[] = [];
      if (turn.message) narration.push(turn.message);
      for (const action of actions) narration.push(callRecord(action));
      if (turn.final !== undefined && turn.final !== turn.message) narration.push(turn.final);
      if (turn.raw) this.messages.push({ role: 'assistant', content: turn.raw });
      else if (narration.length) {
        this.messages.push({ role: 'assistant', content: narration.join('\n') });
      }
      if (turn.message) emit({ type: 'message', text: turn.message });

      if (turn.final !== undefined) {
        emit({ type: 'final', text: turn.final });
        return { final: turn.final, mode: this.mode, events };
      }

      // Every call is answered, including calls a stop request arrived during: a `tool_use` the
      // transcript never answers is a request the model's own API refuses to continue. A tool
      // that throws therefore becomes an error observation rather than an escaped exception.
      for (const action of actions) {
        let observation: string;
        try {
          observation = await this.dispatch(action.tool, action.args, emit);
        } catch (err) {
          const reason = failureText(err);
          emit({
            type: 'tool',
            tool: action.tool,
            args: action.args,
            result: { ok: false, output: reason },
          });
          observation =
            `Error: "${action.tool}" failed: ${reason}\n` +
            `The change may have been partially applied. Re-read the affected file(s) to see ` +
            `what is actually on disk, then retry the edit — or repair from that state — before ` +
            `moving on.`;
        }
        this.messages.push({
          role: 'observation',
          content: observation,
          ...(action.id ? { toolUseId: action.id } : {}),
        });
      }

      // Filed after the observations, never between a call and its answer. Like everything else
      // that changes mid-conversation it is a `{role: 'system'}` message, so it costs one cache
      // write and invalidates nothing.
      if (!warned && spent >= this.budget * 0.8) {
        warned = true;
        this.messages.push({
          role: 'system',
          content: budgetWarning(Math.max(0, this.budget - spent)),
        });
      }
    }

    return this.ranOut(
      `Reached ${this.maxIterations} steps without finishing, which is a runaway rather than a ` +
        'budget — nothing is left to spend here until you say what to do next.',
      emit,
      events,
    );
  }

  /**
   * One call to the model, with whatever the host wants done about a failure.
   *
   * The host is asked once per grant, not once per attempt: it answers with a number of tries,
   * the loop spends them with the backoff the providers ask for, and only when they run out is it
   * asked again, which is what lets "retry ten times" be one decision the author makes rather
   * than ten. A host that implements nothing gets the error, unchanged.
   *
   * The backend is re-read every attempt, so a host that swapped it — a different model, a
   * different vendor — is retried against the new one without saying so.
   */
  private async nextTurn(tools: ToolSpec[], emit: (event: AgentEvent) => void): Promise<AgentTurn> {
    /** Attempts granted and not yet spent, how big that grant was, and how many have failed. */
    let left = 0;
    let of = 0;
    let failures = 0;
    /** A wait the host named when it granted the attempts, which then holds for all of them. */
    let asked: number | undefined;

    for (;;) {
      try {
        const turn = await this.backend.next(this.system, this.messages, tools);
        if (failures > 0) {
          emit({ type: 'api', phase: 'recovered', attempt: failures, of, message: '' });
        }
        return turn;
      } catch (err) {
        failures++;
        const message = failureText(err);
        let wait = apiBackoffMs(failures, retryAfterOf(err));

        if (left === 0) {
          emit({ type: 'api', phase: 'failed', attempt: failures, of, message });
          const recovery =
            this.onApiError && failures < MAX_API_ATTEMPTS
              ? await this.onApiError({
                  message,
                  transient: err instanceof RetryableProviderError,
                  kind: faultKind(err),
                  attempt: failures,
                  waitMs: wait,
                })
              : ({ do: 'stop' } as const);
          if (recovery.do !== 'retry' || recovery.times < 1) {
            emit({ type: 'api', phase: 'gaveup', attempt: failures, of, message });
            throw err;
          }
          left = recovery.times;
          of = recovery.times;
          asked = recovery.waitMs;
        }

        // The host's wait wins over both the provider's and the loop's own, because the host was
        // told what the loop would wait and answered with a different number.
        if (asked !== undefined) wait = asked;

        left--;
        emit({ type: 'api', phase: 'retrying', attempt: of - left, of, message, waitMs: wait });
        if (wait > 0) await sleep(wait);
        // A stop during the wait ends the turn instead of spending the rest of the grant — the
        // attempt has not started, matching the outer loop's stop-between-steps rule. It ends
        // with the usual stop sentence rather than an error: a requested stop is not a failure.
        if (this.stopped) {
          emit({ type: 'api', phase: 'gaveup', attempt: failures, of, message });
          return { final: 'Stopped at your request.' };
        }
      }
    }
  }

  /**
   * Report a turn that could not finish. The message names what was spent and what is on disk
   * since the last commit, because falling out of a loop is otherwise indistinguishable from
   * finishing and the host files whatever comes back as the turn's answer.
   */
  private ranOut(why: string, emit: (event: AgentEvent) => void, events: AgentEvent[]): RunResult {
    const written = this.editedPaths.size
      ? ` Written since the last commit: ${[...this.editedPaths].join(', ')}.`
      : ' Nothing has been written since the last commit.';
    const text = `${why}${written} Say “continue” to keep going, or raise the turn budget.`.replace(
      /\s+/g,
      ' ',
    );
    this.messages.push({ role: 'assistant', content: text });
    emit({ type: 'final', text });
    return { final: text, mode: this.mode, events };
  }

  /** The sentence a budget-exhausted turn opens with. */
  private spentSentence(spent: number): string {
    return (
      `Out of budget for this turn — spent ${spent.toLocaleString()} of ` +
      `${this.budget.toLocaleString()} non-cached tokens (${this.budgetChoice}).`
    );
  }

  /** Gate + execute one action; return the observation text to feed back to the model. */
  private async dispatch(
    name: string,
    args: unknown,
    emit: (event: AgentEvent) => void,
  ): Promise<string> {
    if (name === 'propose_plan') return this.handleProposePlan(args, emit);
    if (name === 'ask_user') return this.handleAskUser(args);
    if (name === 'ask_choice') return this.handleAskChoice(args);

    const tool = this.registry.get(name);
    if (!tool) return `Error: unknown tool "${name}". Use only the listed tools.`;

    if (this.mode === 'plan' && tool.mutating) {
      emit({ type: 'blocked', tool: name, reason: 'mutating tool blocked in plan mode' });
      return (
        `Blocked: "${name}" writes changes and cannot run in plan mode. ` +
        `Use propose_plan to get approval, then apply edits in execute mode.`
      );
    }

    const parsed = tool.args.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      );
      const reason = `invalid arguments — ${detail.join('; ')}`;
      emit({ type: 'blocked', tool: name, reason, args });
      return `Error: invalid arguments for "${name}": ${detail.join('; ')}`;
    }

    if (tool.confirm) {
      const confirmed = await this.permission.confirmAction(name, parsed.data);
      if (!confirmed) {
        emit({ type: 'blocked', tool: name, reason: 'user declined confirmation' });
        return `Declined: the user did not confirm "${name}". The action was not performed.`;
      }
    }

    if (name === 'git_commit') {
      const errors = await this.workspaceErrors();
      if (errors.length) {
        emit({ type: 'blocked', tool: name, reason: 'validation errors block commit' });
        return (
          `Commit blocked: fix ${errors.length} validation error(s) first:\n` + errors.join('\n')
        );
      }
      // Scope the commit to what the agent edited this plan, so a bare `git commit` neither
      // stages nothing nor sweeps in unrelated dirty files from an enclosing repo. A list the
      // model passed is added to what it actually wrote, never substituted for it.
      const commitArgs = parsed.data as { message: string; paths?: string[] };
      commitArgs.paths = [...new Set([...this.editedPaths, ...(commitArgs.paths ?? [])])];
    }

    const result = await tool.run(parsed.data, this.ctx);
    emit({ type: 'tool', tool: name, args: parsed.data, result });
    for (const p of result.written ?? []) this.editedPaths.add(p);
    // One commit per approved plan: a successful commit closes out the tracked edit set.
    if (name === 'git_commit' && result.ok && result.data) this.editedPaths.clear();
    return result.output;
  }

  private async handleProposePlan(
    args: unknown,
    emit: (event: AgentEvent) => void,
  ): Promise<string> {
    const parsed = planSchema.safeParse(args);
    if (!parsed.success) {
      return `Error: invalid plan: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
    }
    const plan: Plan = parsed.data;
    const decision = await this.permission.approvePlan(plan);
    emit({ type: 'plan', plan, decision });
    if (decision.approved) {
      this.mode = 'execute';
      emit({ type: 'mode', mode: 'execute' });
      return 'Plan approved. You are now in execute mode: apply the edits, run validate_inputs, then git_commit.';
    }
    return (
      `Plan rejected${decision.feedback ? `: ${decision.feedback}` : ''}. ` +
      `You remain in plan mode — revise the plan or ask the user for clarification.`
    );
  }

  private async handleAskUser(args: unknown): Promise<string> {
    const parsed = askSchema.safeParse(args);
    if (!parsed.success) return `Error: ask_user needs a non-empty "question".`;
    return this.putForm([{ question: parsed.data.question }]);
  }

  /**
   * The same flow as `ask_user`, with a shortlist attached and — when the model has more than
   * one thing to settle — several questions answered as one form. What comes back is still
   * whatever the author said: a choice they clicked, something they typed instead, or that they
   * would rather discuss it. The observation is therefore worded the same way as `ask_user`'s,
   * and the model has to read it rather than assume a listed choice was picked.
   */
  private async handleAskChoice(args: unknown): Promise<string> {
    const parsed = choiceSchema.safeParse(args);
    if (!parsed.success) {
      return (
        `Error: ask_choice needs a non-empty "question" with at least two "choices", or a ` +
        `"questions" array of up to ${MAX_ASK_QUESTIONS} questions, each with a "question" and ` +
        `optionally two or more "choices".`
      );
    }
    const data = parsed.data;
    return this.putForm('questions' in data ? data.questions : [data]);
  }

  /** Put a form to the host, and turn what came back into the model's observation. */
  private async putForm(form: AskQuestion[]): Promise<string> {
    return askObservation(form, answersFor(form, await this.permission.ask(form)));
  }

  /** Error-severity diagnostics currently in the project (the commit gate). */
  private async workspaceErrors(): Promise<string[]> {
    const { model } = await this.ctx.workspace.load();
    return model.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `[${d.code}] ${d.message}`);
  }
}
