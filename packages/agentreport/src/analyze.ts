/**
 * The debug agent that reads the bad conversation and says what went wrong.
 *
 * There are two paths. Without the source it makes one structured call and no loop, since there is
 * nothing to look up. With the source it runs the ordinary authoring loop against a registry
 * holding read tools and nothing else, because that loop already gates, validates and caps calls.
 * It picks its backend the same way the ordinary hosts do, so the transcript it re-reads every
 * iteration is cached rather than re-sent.
 *
 * Everything the analyst is shown passes through the redactor first, and everything it writes
 * passes through it again before anyone sees it. The prompt also asks for general terms, which is
 * a second layer rather than the mechanism.
 */
import { ConfigError } from '@vn/util';
import { secretFileFor, type ResolvedKeys } from '@vn/config';
import type { EffortChoice, ProjectConfig } from '@vn/types';
import {
  chatBackendFor,
  chatVendorFor,
  withStructuredRetry,
  type ChatBackend,
} from '@vn/providers';
import {
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  type AgentEvent,
  type AskQuestion,
  type Permission,
  type SystemSection,
  type Tool,
  type ToolContext,
} from '@vn/authoring';
import { analysisArgs, type Analysis, type Report } from './report.js';
import type { Redactor } from './redact.js';
import { toMarkdown, type Evidence } from './transcript.js';

const SYSTEM = [
  'You are a debugging analyst. An author of a visual-novel authoring tool had a conversation',
  'with its built-in writing agent that went badly, and has asked for it to be reported to the',
  "tool's maintainers. You are given that conversation and the commands the app executed while",
  'it was open. Work out what the agent did wrong and what it should do instead.',
  '',
  'What the maintainers need from you is the recommendations. A description of the failure they',
  'can read for themselves; a rule the agent should follow so it does not happen again is what',
  'they cannot. State each one as behaviour, not as sympathy.',
  '',
  'The conversation has already had every personal and fictional name replaced: characters and',
  'locations appear as "Character A", "Location B", paths as "<project>/…", the author as',
  '"<author>". Use those terms and invent no others. Never guess at what a pseudonym stands for,',
  'never quote a name you were not given, and prefer describing a thing by its role ("the scene',
  'the author was editing") over naming it at all. This report will be posted publicly.',
  '',
  'Be honest about how much the transcript supports. If it records too little to tell, say so and',
  'set confidence to low — a confident wrong diagnosis costs a maintainer more than an admission.',
  '',
  'What the author says went wrong is the claim you are testing, not a finding. Check it against',
  'the conversation and whatever else you can read. Where the evidence does not settle it, write',
  '"the author reports X" rather than X, and say what would settle it.',
].join('\n');

/**
 * How a run that has tools ends. This is the loop's own protocol rather than a permission, so it is
 * kept separate from the source paragraph below: a run with the request tools and no source needs
 * it just as much, and folding the two together would leave such a run finishing without a report
 * and silently falling back to the single call.
 */
const LOOP_PROTOCOL =
  'When you are finished, call submit_report exactly once. Do not finish your turn without it.';

/**
 * The submit_report protocol for a run the author is sitting in front of. LOOP_PROTOCOL's
 * "exactly once" is wrong here: a conversation that has already filed a report and is then told
 * what it missed has to file another one, and LOOP_PROTOCOL's wording forbids that.
 */
const CHAT_PROTOCOL = [
  'You are talking to the author. Answer what they ask, in a few sentences unless they want more,',
  'and say plainly when the evidence does not settle something.',
  '',
  'Call submit_report before you finish any turn you have reached a conclusion in. When a later',
  'message changes that conclusion, call it again with a whole revised report rather than a',
  'correction — the newest report is the one that gets filed, and the earlier ones stay in the',
  'conversation for the author to compare against.',
].join('\n');

const SOURCE_ACCESS = [
  "You can read the tool's own source code, its documentation, and the files of the project the",
  'author was working on. Use it to check what the agent was actually able to do before you',
  'conclude what it should have done, and to point each recommendation at the file that would',
  'have to change. Read what you need and no more.',
].join('\n');

/**
 * What the request tools are for, plus the one rule about them that code cannot enforce.
 *
 * The capture is the author's own conversation as it went over the wire, read on the author's own
 * key; it is not in the report and must not get into it. The tools return an outline by default and
 * one capped, redacted value at a time, so a long verbatim span is unreachable through them. This
 * paragraph is a second layer rather than the mechanism.
 */
const REQUEST_ACCESS = [
  'You can also read the requests the app actually sent to the model API, which is what a',
  'positional error like "messages.1.content.0" points into. Start with list_requests to find the',
  'one that failed, then read_request with no path for its shape — that alone answers most',
  'positional errors — and only then a path, for one specific value.',
  '',
  'What you read there is private to this machine and does not go in the report. Describe what you',
  'find structurally: which block, of what type, in what position. Never quote its content.',
].join('\n');

/**
 * The tools the agent under report could call, so a recommendation is written against what that
 * agent can reach. Without it the analyst has recommended capabilities the agent has no tool for
 * and cannot be given one for, which reads to a maintainer as a defect rather than a wish.
 */
function reportedTools(tools: readonly ToolSummary[]): string {
  const lines = tools.map((t) => `- \`${t.name}\` — ${t.description.split('\n')[0]!.trim()}`);
  return [
    '## The tools the agent under report had',
    '',
    'This is every tool it could call. A recommendation that asks it to do something outside this',
    'list is asking for a tool that does not exist — say that in as many words if it is the fix.',
    '',
    lines.join('\n'),
  ].join('\n');
}

/**
 * The evidence, plus whatever the author said they were trying to do. Exported because a
 * conversation opens on it: the pane's first message is the same one the headless path makes its
 * only call with, so both paths show the analyst the same thing.
 */
export function openingMessage(opts: AnalyzeOptions): string {
  const { redactor } = opts;
  const parts = [redactor.apply(toMarkdown(opts.evidence))];
  const said = opts.wanted?.trim();
  parts.push(
    said
      ? `## What the author says they wanted\n\n${redactor.apply(said)}`
      : '## What the author says they wanted\n\nThey did not say. Work it out from the conversation.',
  );
  if (opts.reportedTools?.length) parts.push(reportedTools(opts.reportedTools));
  return parts.join('\n\n');
}

/** Put the analyst's own prose through the redactor too — it quotes the transcript back. */
function scrub(analysis: Analysis, redactor: Redactor): Analysis {
  return {
    summary        : redactor.apply(analysis.summary),
    whatHappened   : redactor.apply(analysis.whatHappened),
    whatWentWrong  : analysis.whatWentWrong.map((line) => redactor.apply(line)),
    rootCause      : redactor.apply(analysis.rootCause),
    recommendations: analysis.recommendations.map((rec) => ({
      behaviour: redactor.apply(rec.behaviour),
      ...(rec.where === undefined ? {} : { where: redactor.apply(rec.where) }),
      rationale: redactor.apply(rec.rationale),
    })),
    confidence     : analysis.confidence,
    evidence       : analysis.evidence.map((line) => redactor.apply(line)),
  };
}

/**
 * The chat backend for the analysis model, refusing by name when its key is not resolvable.
 *
 * `resolveKeys` only throws for a vendor the caller declared required, and the caller here cannot
 * know which vendor until the author has picked a model in the dialog — so the check belongs at
 * the point of use. It names the env var and the file, never the value.
 */
export function analystBackend(
  modelId: string,
  config: ProjectConfig,
  keys: ResolvedKeys,
  effort?: EffortChoice,
): ChatBackend {
  const vendor = chatVendorFor(modelId);
  if (!keys[vendor]?.trim()) {
    throw new ConfigError(
      `no ${vendor} API key, so ${modelId} cannot analyse anything: ` +
        `set $${config.keys[vendor]} or put ${secretFileFor(vendor)} in the project's keys/ directory`,
    );
  }
  // Recording is off because the analyst runs many turns, and every one of them would push an
  // entry into the request ring it may be reading from
  return chatBackendFor(modelId, keys, effort, { record: false }).backend;
}

/** One tool of the agent under report, as the analyst is shown it. */
export interface ToolSummary {
  name: string;
  description: string;
}

/** The read tools the analyst gets when the author lets it look at the source. */
export interface SourceAccess {
  /** Holds read-only tools; the loop blocks any tool that declares a write capability. */
  registry: Map<string, Tool>;
  ctx: ToolContext;
}

export interface AnalyzeOptions {
  evidence: Evidence;
  backend: ChatBackend;
  /** Everything in and out passes through this. */
  redactor: Redactor;
  /** The author's own account of what they were trying to do. Optional, and redacted. */
  wanted?: string;
  /**
   * The tools the agent under report ran with, taken from the registry that host actually built.
   * Omitted by a host that cannot say, in which case the analyst is told nothing about them rather
   * than a guess.
   */
  reportedTools?: readonly ToolSummary[];
  /** Present when the author ticked the source box. */
  source?: SourceAccess;
  /**
   * Present when the author ticked the detail box: the tools that read the captured requests.
   * Independent of {@link source} — the two boxes are separate, and either one alone is a loop.
   */
  detail?: Map<string, Tool>;
  /**
   * The context a loop needs when there is no source root to hand it one. Read only when
   * {@link source} is absent and {@link detail} is not — a detail-only run is still a loop.
   */
  ctx?: ToolContext;
  /** Runaway backstop on tool-call iterations for whichever loop runs. */
  maxIterations?: number;
}

/**
 * Nobody is at the keyboard. Plans are approved because the loop would park forever otherwise and
 * the registry holds nothing that could act on one. Confirmations are refused, because a tool that
 * asks for one is asking a person who is not there.
 */
function unattended(): Permission {
  return {
    approvePlan  : async () => ({ approved: true }),
    confirmAction: async () => false,
    ask: async (form) =>
      form.map(
        () =>
          'Nobody is here to answer — this is an automated analysis of a saved conversation. ' +
          'Conclude from the evidence you have, and say in the report what you could not determine.',
      ),
  };
}

/**
 * Someone is at the keyboard, so a question reaches them. Plans are still approved without asking
 * and confirmations are still refused, for the reason they are on the headless path: the registry
 * holds read tools and nothing that could act on either answer.
 */
function attended(host: AnalystHost): Permission {
  return {
    approvePlan  : async () => ({ approved: true }),
    confirmAction: async () => false,
    ask          : (form) => host.ask(form),
  };
}

/** The one call the cheap path makes. */
async function analyzeDirectly(opts: AnalyzeOptions): Promise<Analysis> {
  const prompt = [
    openingMessage(opts),
    '',
    'Reply with a single JSON object and nothing else, with these fields:',
    '  summary, whatHappened, whatWentWrong[], rootCause,',
    '  recommendations[{behaviour, where?, rationale}], confidence, evidence[]',
  ].join('\n');

  return withStructuredRetry(analysisArgs, () => opts.backend.message({ system: SYSTEM, prompt }));
}

/**
 * The tool that ends the source run. The loop validates its args against this schema like any
 * other tool's, so the structure is enforced by the same mechanism and there is no second
 * round-trip asking the model for JSON it has already written.
 */
function submitTool(sink: { report?: Analysis }, attending: boolean): Tool<Analysis> {
  return {
    name       : 'submit_report',
    description: attending
      ? 'File your report. Call this once per turn you have concluded in, and again with a ' +
        'whole revised report when a later message changes your conclusion.'
      : 'File your finished report. Call this exactly once, when you have concluded. ' +
        'After it returns, finish your turn.',
    mutating   : false,
    args       : analysisArgs,
    async run(args) {
      sink.report = args;
      return { ok: true, output: 'Report received. Finish your turn now; nothing else is needed.' };
    },
  };
}

/**
 * A source tool that records the first time it is called. Whether the analyst opened the source is
 * a fact about the run rather than about the offer, and the report says which.
 */
function watched(tool: Tool, read: { source: boolean }): Tool {
  return {
    ...tool,
    run: (args, ctx) => {
      read.source = true;
      return tool.run(args, ctx);
    },
  };
}

/** Every string the analyst wrote, with the names taken back out. */
function redactDeep(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') return redactor.apply(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, redactDeep(val, redactor)]),
    );
  }
  return value;
}

/**
 * One turn's event, ready to show. Every field the model wrote is redacted and every field the loop
 * wrote — the discriminant, the tool's name, a usage count — is left alone, so a reducer can still
 * switch on it after a fiction that named a character "message" has been through.
 */
function redactEvent(event: AgentEvent, redactor: Redactor): AgentEvent {
  const say = (text: string): string => redactor.apply(text);
  switch (event.type) {
    case 'message':
    case 'final':
      return { ...event, text: say(event.text) };
    case 'tool':
      return {
        ...event,
        args  : redactDeep(event.args, redactor),
        result: { ...event.result, output: say(event.result.output) },
      };
    case 'blocked':
      return {
        ...event,
        reason: say(event.reason),
        ...(event.args === undefined ? {} : { args: redactDeep(event.args, redactor) }),
      };
    case 'plan':
      return {
        ...event,
        plan: {
          ...event.plan,
          summary: say(event.plan.summary),
          steps  : event.plan.steps.map(say),
          files  : event.plan.files.map(say),
          ...(event.plan.risks ? { risks: event.plan.risks.map(say) } : {}),
        },
      };
    case 'api':
      return { ...event, message: say(event.message) };
    default:
      return event;
  }
}

/** What a live analyst needs from whoever is watching it. */
export interface AnalystHost {
  /** Put the analyst's questions to the author, one answer per question. */
  ask(form: readonly AskQuestion[]): Promise<string[]>;
  /** Each event of the turn in flight, already redacted. */
  onEvent?(event: AgentEvent): void;
}

/** Read tools handed to a live analyst part way through. */
export interface AnalystGrant {
  /** Which access this is, which decides the system-prompt section that announces it. */
  kind: 'source' | 'detail';
  /** Read tools only, the same rule the initial registries follow. */
  tools: Map<string, Tool>;
}

export interface AnalystOptions extends AnalyzeOptions {
  /**
   * The context every tool runs in. A source run usually carries its own in {@link SourceAccess},
   * and this is what a detail-only run and a later source grant use.
   */
  ctx: ToolContext;
  /** Present when someone is at the keyboard. Absent runs the headless permission. */
  host?: AnalystHost;
}

/** How one turn of a conversation with the analyst ended. */
export interface AnalystTurn {
  /** What the analyst said last, redacted. */
  final: string;
  /** The report filed during this turn, when one was filed. */
  report?: Report;
  /** True when the turn ended because {@link Analyst.stop} was called rather than by concluding. */
  stopped: boolean;
}

/** A conversation with the analyst, held open across turns. */
export interface Analyst {
  /** Run one turn to completion. */
  ask(text: string): Promise<AnalystTurn>;
  /** End the turn in flight after the step it is on. */
  stop(): void;
  /** Add read tools. They are advertised from the next turn, not this one. */
  grant(access: AnalystGrant): void;
  /** The most recent report filed in this conversation. */
  readonly filed: Report | undefined;
}

/**
 * A conversation with the analyst, which one turn is a special case of.
 *
 * There is deliberately no fallback here. `analyze` keeps one because a headless run that files
 * nothing has produced nothing, but a conversation the author stopped has already been told what to
 * do, and answering a stop with another model call spends money they just asked not to spend.
 */
export function createAnalyst(opts: AnalystOptions): Analyst {
  const sink: { report?: Analysis } = {};
  const read = { source: false };
  const offered = { source: Boolean(opts.source), detail: Boolean(opts.detail) };
  const registry = new Map<string, Tool>();
  const add = (kind: AnalystGrant['kind'], tools: Map<string, Tool>): void => {
    for (const [name, tool] of tools) {
      registry.set(name, kind === 'source' ? watched(tool, read) : tool);
    }
  };
  if (opts.source) add('source', opts.source.registry);
  if (opts.detail) add('detail', opts.detail);
  const attending = opts.host !== undefined;
  const submit = submitTool(sink, attending);
  registry.set(submit.name, submit as Tool);

  // Named parts rather than one string: a grant supersedes the section it adds and leaves the rest
  // of the cached prefix alone.
  const sections = (): SystemSection[] => [
    { name: 'analyst', text: SYSTEM },
    ...(offered.source ? [{ name: 'source access', text: SOURCE_ACCESS }] : []),
    ...(offered.detail ? [{ name: 'request access', text: REQUEST_ACCESS }] : []),
    { name: 'protocol', text: attending ? CHAT_PROTOCOL : LOOP_PROTOCOL },
  ];

  // The same probe the desktop app and vnauthor use. Takes the native path when the backend offers
  // a conversation seam, so each iteration reads the transcript out of cache instead of re-paying
  // for it, and the structured path when it does not
  const chat = opts.backend;
  const onEvent = opts.host?.onEvent;
  const agent = new Agent({
    backend: chat.chatConversation
      ? new NativeAgentBackend(chat)
      : new StructuredAgentBackend(chat),
    // Every tool here is needed. Deferring them would buy no context back and would hide
    // submit_report behind tool search, which ends the run without a report
    deferTools: false,
    ctx       : opts.source?.ctx ?? opts.ctx,
    permission: opts.host ? attended(opts.host) : unattended(),
    system    : '',
    registry,
    maxIterations: opts.maxIterations ?? 24,
    ...(onEvent ? { onEvent: (event) => onEvent(redactEvent(event, opts.redactor)) } : {}),
  });
  agent.refreshSystem(sections());

  let filed: Report | undefined;

  const reportOf = (analysis: Analysis): Report => ({
    analysis  : scrub(confidenceOf(analysis, offered.source, read.source), opts.redactor),
    model     : opts.backend.modelId,
    readSource: read.source,
    ...statementOf(opts),
  });

  return {
    get filed() {
      return filed;
    },
    stop() {
      agent.stop();
    },
    grant(access) {
      offered[access.kind] = true;
      add(access.kind, access.tools);
      agent.refreshSystem(sections());
    },
    async ask(text) {
      sink.report = undefined;
      const result = await agent.run(text);
      if (sink.report) filed = reportOf(sink.report);
      return {
        final: opts.redactor.apply(result.final),
        ...(sink.report ? { report: filed } : {}),
        stopped: result.stopped === true,
      };
    },
  };
}

/**
 * The analyst's confidence, capped at `low` when the source was there to read and it did not read
 * it. A run offered no source is left alone: there was nothing to open, so the analyst's own
 * judgement of the transcript is all the report ever had.
 */
function confidenceOf(analysis: Analysis, offered: boolean, read: boolean): Analysis {
  if (!offered || read) return analysis;
  return { ...analysis, confidence: 'low' };
}

/** The author's account, redacted, or absent when they said nothing. */
function statementOf(opts: AnalyzeOptions): { authorStatement?: string } {
  const said = opts.wanted?.trim();
  return said ? { authorStatement: opts.redactor.apply(said) } : {};
}

/**
 * Read the conversation and say what went wrong.
 *
 * The source path falls back to the cheap one rather than failing: an author who has already
 * described a bad experience should not be told the thing that was meant to report it also
 * misbehaved. The fallback is recorded on the report, because a recommendation about a specific
 * file is worth less from an analyst that never opened it.
 */
export async function analyze(opts: AnalyzeOptions): Promise<Report> {
  const model = opts.backend.modelId;
  const ctx = opts.source?.ctx ?? opts.ctx;
  const said = statementOf(opts);

  // A detail-only run has no source root, so its context comes in beside the tools rather than
  // with them
  if ((opts.source || opts.detail) && ctx) {
    const turn = await createAnalyst({ ...opts, ctx }).ask(openingMessage(opts));
    if (turn.report) return turn.report;
    return {
      analysis: scrub(await analyzeDirectly(opts), opts.redactor),
      model,
      readSource: false,
      fellBack  : `the analyst finished without filing one — it said: ${turn.final}`,
      ...said,
    };
  }

  return {
    analysis: scrub(await analyzeDirectly(opts), opts.redactor),
    model,
    readSource: false,
    ...said,
  };
}
