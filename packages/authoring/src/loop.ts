/**
 * The conversation loop, plan-mode state machine, and permission gate (authoring-agent
 * plan §6.4, §7). The loop is written against the `AgentBackend` seam so the tool-call
 * protocol can change without touching policy. Policy lives here, deterministically:
 *
 * - **plan mode (read-only):** only `mutating: false` tools dispatch; the gate rejects
 *   mutating tools and tells the model to `propose_plan` first.
 * - **execute mode (read-write):** entered only after the user approves a proposed plan.
 *   Mutating tools dispatch; `git_commit` is blocked while error-severity diagnostics
 *   remain, matching "block commit on hard errors, warn on soft".
 * - **always-confirm:** any `confirm: true` tool (revert/restore) routes through the
 *   permission gate regardless of mode.
 *
 * Control tools (`propose_plan`, `ask_user`, `ask_choice`) are handled by the loop, not the
 * registry — they drive the state machine rather than touch the workspace.
 */
import { z } from 'zod';
import { budgetTokens, charge, DEFAULT_BUDGET, type BudgetChoice } from '@vn/types';
import { RetryableProviderError } from '@vn/util';
import type { AgentAction, AgentBackend, AgentMessage, AgentTurn, ToolSpec } from './backend.js';
import { joinSections, type SystemSection } from './context.js';
import {
  createRegistry,
  describeToolParams,
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
   * Put a form to the author and get one answer per question, positionally. A host that answers
   * short is padded and one that answers long is truncated by {@link answersFor}, because a turn
   * parked on an answer must not hang on a host's arithmetic.
   */
  ask(form: readonly AskQuestion[]): Promise<string[]>;
}

/**
 * One question of an ask form.
 *
 * `choices` is a shortlist offered *with* the question rather than a second kind of question,
 * because the answer is a string either way: the list is how the question is put, not what comes
 * back — the author may always type something that is not on it, and the agent is told verbatim
 * what they said. A host that ignores it asks the question as plain text, which is degraded but
 * never wrong.
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
 * `attempt` counts the failures of *this step*, so `1` is the first thing that went wrong and
 * anything higher means the attempts the host last granted are spent. `waitMs` is what the loop
 * would wait on its own — the provider's `retry-after` where it sent one, and an exponential
 * backoff where it did not.
 */
export interface ApiFailure {
  message: string;
  /** Whether another attempt could plausibly get a different answer: a 429, a 5xx, a dead socket. */
  transient: boolean;
  attempt: number;
  waitMs: number;
}

/**
 * What the host wants done about it.
 *
 * There is no `switch model` here on purpose: the loop has never known what a model is, and the
 * host that does can swap the backend itself ({@link Agent.setBackend}) before answering `retry`.
 * The next attempt reads the field, so the swap lands on it.
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
  /** Give up: the error leaves `run` and the caller reports it as it always did. */
  | { do: 'stop' };

/** A streamed event describing one thing the loop did (for the REPL / test assertions). */
export type AgentEvent =
  | { type: 'message'; text: string }
  | { type: 'tool'; tool: string; args: unknown; result: ToolResult }
  | { type: 'plan'; plan: Plan; decision: PlanDecision }
  | { type: 'mode'; mode: AgentMode }
  // `args` is present where there were any to show — a call the schema refused never ran, so
  // there is no `tool` event for it, and without the arguments the refusal names a field nobody
  // can see. It is the same evidence a `tool` event carries, for a call that did not happen.
  | { type: 'blocked'; tool: string; reason: string; args?: unknown }
  // What one step cost. Emitted only when the provider reported it, so a host that adds these up
  // shows either a real total or none — never a plausible one that never moves. The cache split
  // is carved out of `input` rather than added beside it, and absent where the provider said
  // nothing, which is not the same as a cache that missed. `cacheEstimated` marks a split that is
  // a matched-prefix count rather than a billed one — Gemini's implicit cache.
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheEstimated?: boolean;
    }
  // How a call to the model is going when it does not simply work. `failed` is one attempt gone
  // and the host about to be asked; `retrying` is attempt `attempt` of `of` about to be made, and
  // is the only phase a counter should be *up* for; `recovered` and `gaveup` both end the story,
  // so a surface that shows one clears on either. `attempt` on those two is how many failed.
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
  /** Optional live event sink (the REPL renders these as they happen). */
  onEvent?: (event: AgentEvent) => void;
  /**
   * What to do when the call to the model fails. Absent is the behaviour there has always been:
   * the error leaves `run` and the caller reports it. A host that implements it can offer the
   * author the choice instead — retry, or swap the backend and retry — without the loop knowing
   * anything about providers.
   */
  onApiError?: (failure: ApiFailure) => Promise<ApiRecovery>;
}

/**
 * A form is a handful of questions, not a survey. The author can get on with nothing while one is
 * up, so a model that wants more than this has stopped asking and started interviewing — what it
 * needs is to go and read the project.
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
 * against any budget and would otherwise loop until the process died. `unlimited` means unlimited
 * *budget*; it is still backstopped.
 */
const MAX_ITERATIONS = 200;

/** Where a retry's own backoff starts and where it stops growing. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;

/**
 * The backstop on retrying one step. Not a policy knob — the policy is whatever the host answers
 * — but a host that keeps saying `retry` to a failure that is never going to clear would
 * otherwise spend the author's evening asking a dead endpoint the same question.
 */
const MAX_API_ATTEMPTS = 50;

/**
 * How long to wait before attempt `attempt` of the same step, in ms.
 *
 * `after` is what the provider itself asked for and wins outright, because the response is the
 * only thing that knows when a limit resets. Otherwise it is the doubling every vendor's guidance
 * describes, capped so a long grant cannot end up sleeping for an hour.
 *
 * Deliberately without jitter, which that guidance also calls for: jitter is there to keep a
 * *fleet* of clients from retrying in lockstep, and there is one conversation here. What it would
 * buy instead is a wait no test can pin.
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

/** What the model is told as the ceiling comes into view. The instruction, not the number alone. */
function budgetWarning(left: number): string {
  return (
    `BUDGET: about ${left.toLocaleString()} tokens remain this turn. Stop starting new work. ` +
    'Finish and commit what is in progress, then reply telling the author exactly what landed ' +
    'and what is left.'
  );
}

/** How the mode is stated to the model. The whole sentence, so re-filing it re-states the rule. */
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

// Two is the floor: a "shortlist" of one is a leading question, and the author would have to
// reach for the text box to disagree with it.
const oneChoiceSchema = z.object({
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2),
  multi: z.boolean().default(false),
});

/**
 * A question *inside a form* may omit its shortlist. On its own that would be `ask_user` and this
 * tool would be the wrong door, but a form is one parked turn: making the model ask the listed
 * questions here and the open one separately would cost a second turn to learn nothing extra.
 */
const formItemSchema = oneChoiceSchema.extend({
  choices: oneChoiceSchema.shape.choices.optional(),
});

/**
 * Either shape is accepted, because both are honest: one question is the common case and should
 * not have to be wrapped in an array to be asked.
 */
const choiceSchema = z.union([
  oneChoiceSchema,
  z.object({ questions: z.array(formItemSchema).min(1).max(MAX_ASK_QUESTIONS) }),
]);

/**
 * The answers, made to match the form: a host that answered short leaves the rest unanswered, and
 * one that answered long has the surplus dropped. Neither is a throw — the model reads these as
 * prose, and a missing answer says "nothing" perfectly well.
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
  /** Which choice {@link budget} came from — what a sentence about running out quotes. */
  private budgetChoice: BudgetChoice;
  private readonly maxIterations: number;
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly onApiError?: (failure: ApiFailure) => Promise<ApiRecovery>;
  private readonly messages: AgentMessage[] = [];
  /** Workspace-relative paths the agent has written since the last commit (commit scope). */
  private readonly editedPaths = new Set<string>();
  /** What the agent has been shown of each file this conversation — `edit_file`'s staleness check. */
  private readonly seen: ReadLedger = new Map();
  private mode: AgentMode;
  /** The mode the transcript last stated. Differs from {@link mode} exactly when one is owed. */
  private filedMode?: AgentMode;
  /** The system-prompt sections this conversation was started with, by name. */
  private sections = new Map<string, string>();
  /** System messages owed to the model, filed after the next user turn (never before one). */
  private readonly pendingSystem: string[] = [];
  /** Set by {@link stop}, cleared when a turn starts. Read between steps, never inside one. */
  private stopped = false;

  constructor(opts: AgentOptions) {
    this.backend = opts.backend;
    // Give tools a confirmation channel (script-bearing skills) routed to the gate, unless
    // the host already supplied one.
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
    // Nothing has been stated to a transcript that no longer exists, and the next
    // `refreshSystem` rebuilds the prompt outright rather than superseding into thin air.
    this.filedMode = undefined;
    this.pendingSystem.length = 0;
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
   * The tool catalog advertised to the backend (registry + control tools), each flagged for
   * whether it may be deferred. Derived from a static list and the registry's own order, so two
   * turns of one conversation produce byte-identical catalogs — the prefix everything else caches
   * behind.
   */
  private toolSpecs(): ToolSpec[] {
    const fromRegistry = [...this.registry.values()].map((t) => ({
      name: t.name,
      description: t.description,
      mutating: t.mutating,
      parameters: describeToolParams(t.args),
    }));
    return [...fromRegistry, ...CONTROL_TOOLS].map((t) => ({
      ...t,
      ...(ALWAYS_LOADED.has(t.name) ? {} : { defer: true }),
    }));
  }

  /**
   * Run one user turn to completion (a final message), driving tool calls in between.
   *
   * `focus` is what the host knew when the turn started — the scene on screen, typically. It is
   * filed as a `context` message ahead of the user's, so "rewrite this line" has a *this*; a host
   * that knows nothing passes nothing, and the transcript reads exactly as it did before.
   */
  async run(userInput: string, focus?: string): Promise<RunResult> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      this.onEvent?.(event);
    };

    if (focus) this.messages.push({ role: 'context', content: focus });
    this.messages.push({ role: 'user', content: userInput });
    // After the user's message, never before it: a system message may not open a conversation,
    // and must follow a user turn. Sections first, mode last — policy is what should read last.
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
        return { final: text, mode: this.mode, events };
      }

      // The same rule `stop()` follows, for the same reason: a budget exhausted mid-reply still
      // dispatches every call in that reply, because a `tool_use` the transcript never answers
      // is a request the API will refuse to continue.
      if (spent >= this.budget) return this.ranOut(this.spentSentence(spent), emit, events);

      const turn = await this.nextTurn(tools, emit);
      // Before the narration: the call is already paid for whether or not it said anything useful.
      if (turn.usage) {
        spent += charge(turn.usage);
        emit({ type: 'usage', ...turn.usage });
      }

      const actions = turn.actions ?? [];
      // One assistant message per step. `raw` when the provider sent blocks — echoing them back
      // unmodified is the contract — and otherwise the narration, with each call written out as
      // the JSON the model emitted so the next turn can read what it asked for.
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

      // Every call is answered, including the ones a stop request arrived during: a `tool_use`
      // the transcript never answers is a request the model's own API will refuse to continue.
      for (const action of actions) {
        const observation = await this.dispatch(action.tool, action.args, emit);
        this.messages.push({
          role: 'observation',
          content: observation,
          ...(action.id ? { toolUseId: action.id } : {}),
        });
      }

      // After the observations, never between a call and its answer. Filed as a `{role: 'system'}`
      // message like everything else that changes mid-conversation, so it costs one cache write
      // and invalidates nothing.
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
   * How a turn that could not finish reports. It names what was spent and what is on disk since
   * the last commit, because falling out of a loop is otherwise indistinguishable from finishing
   * and the host files whatever comes back as the turn's answer.
   */
  /**
   * One call to the model, with whatever the host wants done about a failure.
   *
   * The host is asked once per *grant*, not once per attempt: it answers with a number of tries,
   * the loop spends them with the backoff the providers ask for, and only when they run out is it
   * asked again — which is what lets "retry ten times" be one decision the author makes rather
   * than ten. A host that implements nothing gets what it always got: the error, unchanged.
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

        // The host's wait wins over both the provider's and ours: it was told what we were going
        // to wait and answered with a different number, which is only meaningful if it is used.
        if (asked !== undefined) wait = asked;

        left--;
        emit({ type: 'api', phase: 'retrying', attempt: of - left, of, message, waitMs: wait });
        if (wait > 0) await sleep(wait);
        // A stop during the wait ends the turn instead of spending the rest of the grant. The
        // attempt has not been made yet, so this is the same "after the step it is on" the outer
        // loop honours — and it ends with the sentence a stop always ends with rather than an
        // error, because the author asking for it to be over is not a failure.
        if (this.stopped) {
          emit({ type: 'api', phase: 'gaveup', attempt: failures, of, message });
          return { final: 'Stopped at your request.' };
        }
      }
    }
  }

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
      // Scope the commit to exactly what the agent edited this plan. Without this the bare
      // `git commit` stages nothing (and fails), and would otherwise risk sweeping in
      // unrelated dirty files when the workspace sits inside a larger repo.
      //
      // A list the model passed is *added to* what it actually wrote, never substituted for it:
      // the record is complete and the memory is not, which is how an AICONTEXT.md the agent
      // updated and then forgot about went uncommitted.
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
   * The same door as `ask_user`, with a shortlist attached and — when the model has more than one
   * thing to settle — several questions behind it, which the author answers as one form. What
   * comes back is still whatever the author said: a choice they clicked, something they typed
   * instead, or that they would rather discuss it. So the observation is worded no differently
   * and the model has to read it.
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
