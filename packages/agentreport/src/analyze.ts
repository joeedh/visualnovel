/**
 * The debug agent: what actually reads the bad conversation and says what went wrong.
 *
 * Two paths, deliberately different in kind. Without the source it is one structured call and no
 * loop — there is nothing to look up, so a loop would only be an opportunity to wander. With the
 * source it is the ordinary authoring loop pointed at a registry holding read tools and nothing
 * else, because that loop already gates, validates and caps, and re-implementing it here would be
 * a second thing to get wrong.
 *
 * Everything the analyst is shown has been through the redactor first, and everything it writes
 * goes back through it before anyone sees it. The prompt asks for general terms as well; that is
 * the second layer, not the mechanism.
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
  StructuredAgentBackend,
  type Permission,
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
].join('\n');

const WITH_SOURCE = [
  '',
  "You can read the tool's own source code, its documentation, and the files of the project the",
  'author was working on. Use it to check what the agent was actually able to do before you',
  'conclude what it should have done, and to point each recommendation at the file that would',
  'have to change. Read what you need and no more.',
  '',
  'When you are finished, call submit_report exactly once. Do not finish your turn without it.',
].join('\n');

/** The prompt: the evidence, plus whatever the author said they were trying to do. */
function userPrompt(evidence: Evidence, wanted: string | undefined, redactor: Redactor): string {
  const parts = [redactor.apply(toMarkdown(evidence))];
  const said = wanted?.trim();
  parts.push(
    said
      ? `## What the author says they wanted\n\n${redactor.apply(said)}`
      : '## What the author says they wanted\n\nThey did not say. Work it out from the conversation.',
  );
  return parts.join('\n\n');
}

/** Put the analyst's own prose through the redactor too — it quotes the transcript back. */
function scrub(analysis: Analysis, redactor: Redactor): Analysis {
  return {
    summary: redactor.apply(analysis.summary),
    whatHappened: redactor.apply(analysis.whatHappened),
    whatWentWrong: analysis.whatWentWrong.map((line) => redactor.apply(line)),
    rootCause: redactor.apply(analysis.rootCause),
    recommendations: analysis.recommendations.map((rec) => ({
      behaviour: redactor.apply(rec.behaviour),
      ...(rec.where === undefined ? {} : { where: redactor.apply(rec.where) }),
      rationale: redactor.apply(rec.rationale),
    })),
    confidence: analysis.confidence,
    evidence: analysis.evidence.map((line) => redactor.apply(line)),
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
  return chatBackendFor(modelId, keys, effort).backend;
}

/** The read tools the analyst gets when the author lets it look at the source. */
export interface SourceAccess {
  /** Read tools only. Nothing here may write, and the loop blocks anything that says it does. */
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
  /** Present when the author ticked the box. Absent is the cheap path. */
  source?: SourceAccess;
  /** Cap on tool-call iterations for the source path. */
  maxSteps?: number;
}

/**
 * Nobody is at the keyboard. A plan is approved because the loop parks forever otherwise and the
 * registry holds nothing that could act on one; a confirmation is **refused**, because a tool that
 * asks for one is asking a person, and there isn't one.
 */
function unattended(): Permission {
  return {
    approvePlan: async () => ({ approved: true }),
    confirmAction: async () => false,
    ask: async () =>
      'Nobody is here to answer — this is an automated analysis of a saved conversation. ' +
      'Conclude from the evidence you have, and say in the report what you could not determine.',
  };
}

/** The one call the cheap path makes. */
async function analyzeDirectly(opts: AnalyzeOptions): Promise<Analysis> {
  const prompt = [
    userPrompt(opts.evidence, opts.wanted, opts.redactor),
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
function submitTool(sink: { report?: Analysis }): Tool<Analysis> {
  return {
    name: 'submit_report',
    description:
      'File your finished report. Call this exactly once, when you have concluded. ' +
      'After it returns, finish your turn.',
    mutating: false,
    args: analysisArgs,
    async run(args) {
      sink.report = args;
      return { ok: true, output: 'Report received. Finish your turn now; nothing else is needed.' };
    },
  };
}

async function analyzeWithSource(
  opts: AnalyzeOptions,
  source: SourceAccess,
): Promise<{ analysis?: Analysis; why?: string }> {
  const sink: { report?: Analysis } = {};
  const registry = new Map(source.registry);
  const submit = submitTool(sink);
  registry.set(submit.name, submit as Tool);

  const agent = new Agent({
    backend: new StructuredAgentBackend(opts.backend),
    ctx: source.ctx,
    permission: unattended(),
    system: `${SYSTEM}${WITH_SOURCE}`,
    registry,
    maxSteps: opts.maxSteps ?? 24,
  });

  const result = await agent.run(userPrompt(opts.evidence, opts.wanted, opts.redactor));
  if (sink.report) return { analysis: sink.report };
  return { why: `the analyst finished without filing one — it said: ${result.final}` };
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

  if (opts.source) {
    const { analysis, why } = await analyzeWithSource(opts, opts.source);
    if (analysis) {
      return { analysis: scrub(analysis, opts.redactor), model, readSource: true };
    }
    return {
      analysis: scrub(await analyzeDirectly(opts), opts.redactor),
      model,
      readSource: false,
      fellBack: why,
    };
  }

  return { analysis: scrub(await analyzeDirectly(opts), opts.redactor), model, readSource: false };
}
