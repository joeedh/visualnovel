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
import type { AgentBackend, AgentMessage, ToolSpec } from './backend.js';
import {
  createRegistry,
  describeToolParams,
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
  ask(question: string, choices?: AskChoices): Promise<string>;
}

/**
 * A shortlist offered with a question. It is a parameter of `ask` rather than a second door
 * because the answer is a string either way: the list is how the question is *put*, not what
 * comes back — the author may always type something that is not on it, and the agent is told
 * verbatim what they said. A host that ignores it asks the question as plain text, which is
 * degraded but never wrong.
 */
export interface AskChoices {
  options: string[];
  /** Whether more than one may be picked. */
  multi: boolean;
}

/** A streamed event describing one thing the loop did (for the REPL / test assertions). */
export type AgentEvent =
  | { type: 'message'; text: string }
  | { type: 'tool'; tool: string; args: unknown; result: ToolResult }
  | { type: 'plan'; plan: Plan; decision: PlanDecision }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'blocked'; tool: string; reason: string }
  // What one step cost. Emitted only when the provider reported it, so a host that adds these up
  // shows either a real total or none — never a plausible one that never moves.
  | { type: 'usage'; input: number; output: number }
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
  /** Safety cap on tool-call iterations per `run`. */
  maxSteps?: number;
  /** Optional live event sink (the REPL renders these as they happen). */
  onEvent?: (event: AgentEvent) => void;
}

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
      'Ask the user a question and offer a shortlist of answers. args: {question, choices[], multi?}. ' +
      'Prefer this over ask_user whenever the sensible answers can be listed — it is far less work ' +
      'to answer. The user may still type something that is not on the list, or say they would ' +
      'rather talk it through; either way you get their answer verbatim.',
    mutating: false,
  },
];

const planSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  risks: z.array(z.string()).optional(),
});

const askSchema = z.object({ question: z.string().min(1) });

// Two is the floor: a "shortlist" of one is a leading question, and the author would have to
// reach for the text box to disagree with it.
const choiceSchema = z.object({
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2),
  multi: z.boolean().default(false),
});

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
  private readonly maxSteps: number;
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly messages: AgentMessage[] = [];
  /** Workspace-relative paths the agent has written since the last commit (commit scope). */
  private readonly editedPaths = new Set<string>();
  private mode: AgentMode;
  /** Set by {@link stop}, cleared when a turn starts. Read between steps, never inside one. */
  private stopped = false;

  constructor(opts: AgentOptions) {
    this.backend = opts.backend;
    // Give tools a confirmation channel (script-bearing skills) routed to the gate, unless
    // the host already supplied one.
    this.ctx = {
      ...opts.ctx,
      confirm:
        opts.ctx.confirm ??
        ((message: string) => opts.permission.confirmAction('run_skill', { message })),
    };
    this.permission = opts.permission;
    this.system = opts.system;
    this.registry = opts.registry ?? createRegistry();
    this.mode = opts.mode ?? 'plan';
    this.maxSteps = opts.maxSteps ?? 24;
    this.onEvent = opts.onEvent;
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

  /**
   * Reset the conversation (the `/clear` command): drop the transcript and the tracked edit
   * set, and return to plan mode. Files on disk and git history are untouched — only the
   * agent's in-memory context is cleared.
   */
  clear(): void {
    this.messages.length = 0;
    this.editedPaths.clear();
    this.mode = 'plan';
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
   * Recompose the system message. The project map inside it is a snapshot of a file, so an agent
   * that outlives a rewrite of that file — which `update_context` and the desktop's own commands
   * both do — would otherwise keep quoting the version it was built with.
   */
  setSystem(system: string): void {
    this.system = system;
  }

  /** The tool catalog advertised to the backend (registry + control tools). */
  private toolSpecs(): ToolSpec[] {
    const fromRegistry = [...this.registry.values()].map((t) => ({
      name: t.name,
      description: t.description,
      mutating: t.mutating,
      parameters: describeToolParams(t.args),
    }));
    return [...fromRegistry, ...CONTROL_TOOLS];
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
    const tools = this.toolSpecs();
    this.stopped = false;

    for (let step = 0; step < this.maxSteps; step++) {
      // Between steps, so a stop lands after the tool in flight rather than during it.
      if (this.stopped) {
        const text = 'Stopped at your request.';
        this.messages.push({ role: 'assistant', content: text });
        emit({ type: 'final', text });
        return { final: text, mode: this.mode, events };
      }

      const turn = await this.backend.next(this.system, this.messages, tools, this.mode);
      // Before the narration: the call is already paid for whether or not it said anything useful.
      if (turn.usage) emit({ type: 'usage', ...turn.usage });

      const narration: string[] = [];
      if (turn.message) narration.push(turn.message);
      if (turn.action) narration.push(`(calling ${turn.action.tool})`);
      if (narration.length) this.messages.push({ role: 'assistant', content: narration.join(' ') });
      if (turn.message) emit({ type: 'message', text: turn.message });

      if (turn.final !== undefined) {
        this.messages.push({ role: 'assistant', content: turn.final });
        emit({ type: 'final', text: turn.final });
        return { final: turn.final, mode: this.mode, events };
      }

      if (!turn.action) continue;
      const observation = await this.dispatch(turn.action.tool, turn.action.args, emit);
      this.messages.push({ role: 'observation', content: observation });
    }

    const text = 'Reached the step limit before finishing; stopping to avoid looping.';
    emit({ type: 'final', text });
    return { final: text, mode: this.mode, events };
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
      const commitArgs = parsed.data as { message: string; paths?: string[] };
      if (!commitArgs.paths || commitArgs.paths.length === 0) {
        commitArgs.paths = [...this.editedPaths];
      }
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
    const answer = await this.permission.ask(parsed.data.question);
    return `User answered: ${answer}`;
  }

  /**
   * The same door as `ask_user`, with a shortlist attached. What comes back is still whatever the
   * author said — a choice they clicked, something they typed instead, or that they would rather
   * discuss it — so the observation is worded no differently and the model has to read it.
   */
  private async handleAskChoice(args: unknown): Promise<string> {
    const parsed = choiceSchema.safeParse(args);
    if (!parsed.success) {
      return `Error: ask_choice needs a non-empty "question" and at least two "choices".`;
    }
    const { question, choices, multi } = parsed.data;
    const answer = await this.permission.ask(question, { options: choices, multi });
    return `User answered: ${answer}`;
  }

  /** Error-severity diagnostics currently in the project (the commit gate). */
  private async workspaceErrors(): Promise<string[]> {
    const { model } = await this.ctx.workspace.load();
    return model.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `[${d.code}] ${d.message}`);
  }
}
