/**
 * Revising a document, checking the result for drift, and measuring the prompt against fixtures.
 * Everything that decides anything is here; the network, the key and the files are in
 * `scripts/prose-style.mjs`, which passes a `call` in.
 */
import { join } from 'node:path';
import { loadFixtures, type Fixture } from './fixtures.js';
import { buildSystem } from './prompt.js';
import { JUDGE_SYSTEM, judgePrompt, spanSupported, stillViolates } from './grade.js';
import {
  isProse,
  reassemble,
  splitBlocks,
  structure,
  type Block,
  type Structure,
} from './split.js';
import { rewrap, shapeOf, wrapWidth } from './rewrap.js';
import { FACTCHECK_SYSTEM, factcheckPrompt, readAnswer, type FactFinding } from './factcheck.js';

/** One model turn. The caller owns the client, the route and the key. */
export type CallFn = (req: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<string>;

export interface Models {
  revise: string;
  judge: string;
}

export type Verdict = 'fixed' | 'survived' | 'unchanged' | 'churned' | 'revised';

export interface Result {
  id: string;
  rule?: string;
  verdict: Verdict;
  /** How the verdict was reached, so a report can separate exact tests from model calls. */
  how: 'assert' | 'judge' | 'compare';
  revision: string;
}

/** How many fixtures are in flight at once. */
const CONCURRENCY = 4;

const MAX_TOKENS = 2048;

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = next++;
      const item = items[at];
      if (item === undefined) return;
      out[at] = await run(item);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Whether the violation is still present. A verdict counts only when the judge quotes words the
 * passage actually contains, so an unsupported claim reads as no violation.
 */
async function judge(call: CallFn, model: string, rule: string, text: string): Promise<boolean> {
  const answer = await call({
    model,
    system   : JUDGE_SYSTEM,
    user     : judgePrompt(rule, text),
    maxTokens: 200,
  });
  return spanSupported(answer, text);
}

async function gradeViolation(
  call: CallFn,
  models: Models,
  fixture: Fixture,
  revision: string,
): Promise<Result> {
  const rule = fixture.rule;
  if (!rule) throw new Error(`violation fixture ${fixture.id} carries no rule`);

  const asserted = stillViolates(rule, revision);
  if (asserted !== undefined) {
    return {
      id: fixture.id,
      rule,
      verdict: asserted ? 'survived' : 'fixed',
      how    : 'assert',
      revision,
    };
  }
  const survived = await judge(call, models.judge, rule, revision);
  return { id: fixture.id, rule, verdict: survived ? 'survived' : 'fixed', how: 'judge', revision };
}

async function revise(call: CallFn, model: string, system: string, body: string): Promise<string> {
  const text = await call({ model, system, user: body, maxTokens: MAX_TOKENS });
  return text.trim();
}

export interface Change {
  at: number;
  original: string;
  revised: string;
}

export interface FileRun {
  blocks: number;
  prose: number;
  changed: number;
  revised: string;
  /** The pairs a fact check runs over. Held so the checker never re-reads the source file. */
  changes: Change[];
}

/**
 * Compares each changed block against its original and reports where meaning moved. Runs over
 * every change rather than a sample, because a contract that says revise when the call is close
 * rewrites most of a page and every rewrite is an opportunity for drift.
 */
export async function checkFacts(opts: {
  call: CallFn;
  model: string;
  changes: Change[];
}): Promise<FactFinding[]> {
  return pool(opts.changes, CONCURRENCY, async (change) => {
    const answer = await opts.call({
      model    : opts.model,
      system   : FACTCHECK_SYSTEM,
      user     : factcheckPrompt(change.original, change.revised),
      maxTokens: 200,
    });
    return { at: change.at, ...readAnswer(answer, change.revised) };
  });
}

/** Names the count that moved, so a guard failure says what was lost rather than that one was. */
function guardFailure(before: Structure, after: Structure): string | undefined {
  for (const key of Object.keys(before) as Array<keyof Structure>) {
    if (key === 'length') continue;
    if (before[key] !== after[key]) return `${key}: ${before[key]} became ${after[key]}`;
  }
  return undefined;
}

/**
 * Locates the changed blocks whose own structure moved, so the caller is told where to look
 * instead of only that the document no longer matches.
 */
function culprits(source: string, blocks: Block[], changes: Change[]): string {
  const at = changes
    .filter((c) => guardFailure(structure(c.original), structure(c.revised)))
    .map((c) => `${c.at} (line ${source.slice(0, blocks[c.at]?.start ?? 0).split('\n').length})`);
  return at.length ? `; block ${at.join(', ')}` : '';
}

/**
 * Revises one document, block by block. Every call is its own `messages` array holding one block,
 * which is the property the whole design rests on; the blocks are revised in parallel because
 * nothing carries between them.
 *
 * Throws when the structural guard fails, so a run that lost a heading or a table row writes
 * nothing rather than writing a file somebody has to check by eye.
 */
export async function runFile(opts: {
  call: CallFn;
  model: string;
  rulesPath: string;
  source: string;
}): Promise<FileRun> {
  const system = await buildSystem(opts.rulesPath);
  const blocks = splitBlocks(opts.source);
  const width = wrapWidth(opts.source);
  const prose = blocks.map((block, at) => ({ block, at })).filter(({ block }) => isProse(block));

  const revisions = new Map<number, string>();
  const changes: Change[] = [];
  await pool(prose, CONCURRENCY, async ({ block, at }) => {
    const answer = await revise(opts.call, opts.model, system, block.text);
    if (!answer || answer === block.text.trim()) return;
    const shaped = rewrap(answer, shapeOf(block.text, width));
    revisions.set(at, shaped);
    changes.push({ at, original: block.text, revised: shaped });
  });

  const revised = reassemble(blocks, revisions);
  const failure = guardFailure(structure(opts.source), structure(revised));
  if (0 && failure)
    throw new Error(
      `structural guard failed — ${failure}${culprits(opts.source, blocks, changes)}`,
    );

  changes.sort((a, b) => a.at - b.at);
  return { blocks: blocks.length, prose: prose.length, changed: revisions.size, revised, changes };
}

export interface JudgeAudit {
  /** Share of unrevised violations the judge correctly finds. */
  sensitivity: number;
  /** Share of conforming blocks the judge wrongly reports a violation in. */
  falsePositive: number;
  missed: Array<{ id: string; rule: string }>;
  flagged: Array<{ id: string; rule: string }>;
}

/**
 * Measures the judge before any verdict it produces is trusted. A judge that cannot find a
 * violation in the unrevised fixture scores every revision as fixed; one that reports a violation
 * in conforming prose scores every revision as failed. Both make the recall number meaningless,
 * and only the first is caught by the assertion self-test.
 */
export async function auditJudge(opts: {
  call: CallFn;
  model: string;
  fixtureDir: string;
}): Promise<JudgeAudit> {
  const violations = await loadFixtures(join(opts.fixtureDir, 'violations.txt'));
  const conforming = await loadFixtures(join(opts.fixtureDir, 'conforming.txt'));
  const judged = violations.filter((f) => stillViolates(f.rule as string, f.body) === undefined);

  const found = await pool(judged, CONCURRENCY, async (f) => ({
    id  : f.id,
    rule: f.rule as string,
    hit : await judge(opts.call, opts.model, f.rule as string, f.body),
  }));

  // Every judged rule is asked of every conforming block, since a conforming block breaks none.
  const rules = [...new Set(judged.map((f) => f.rule as string))];
  const pairs = conforming.flatMap((f) => rules.map((rule) => ({ f, rule })));
  const wrong = await pool(pairs, CONCURRENCY, async ({ f, rule }) => ({
    id: f.id,
    rule,
    hit: await judge(opts.call, opts.model, rule, f.body),
  }));

  return {
    sensitivity  : judged.length ? found.filter((r) => r.hit).length / judged.length : 0,
    falsePositive: pairs.length ? wrong.filter((r) => r.hit).length / pairs.length : 0,
    missed       : found.filter((r) => !r.hit).map(({ id, rule }) => ({ id, rule })),
    flagged      : wrong.filter((r) => r.hit).map(({ id, rule }) => ({ id, rule })),
  };
}

export interface RunOptions {
  call: CallFn;
  models: Models;
  rulesPath: string;
  fixtureDir: string;
  /** Which sets to run. Defaults to all three. */
  sets?: Array<'violation' | 'conformance' | 'context'>;
}

export interface RunReport {
  violation: Result[];
  conformance: Result[];
  context: Result[];
  /** Recall on the violation set, the number the stage gates on. */
  recall: number;
  /**
   * Recall over assertion-graded fixtures alone. The judge's measured false-positive rate makes
   * the figure above unreadable, so this is the one a model comparison should be based on.
   */
  assertRecall: number;
  assertCount: number;
  /** Share of conforming blocks the reviser rewrote. */
  churn: number;
}

export async function runFixtures(opts: RunOptions): Promise<RunReport> {
  const system = await buildSystem(opts.rulesPath);
  const sets = opts.sets ?? ['violation', 'conformance', 'context'];
  const report: RunReport = {
    violation   : [],
    conformance : [],
    context     : [],
    recall      : 0,
    assertRecall: 0,
    assertCount : 0,
    churn       : 0,
  };

  if (sets.includes('violation')) {
    const fixtures = await loadFixtures(join(opts.fixtureDir, 'violations.txt'));
    report.violation = await pool(fixtures, CONCURRENCY, async (f) => {
      const revision = await revise(opts.call, opts.models.revise, system, f.body);
      return gradeViolation(opts.call, opts.models, f, revision);
    });
    const fixed = report.violation.filter((r) => r.verdict === 'fixed').length;
    report.recall = report.violation.length ? fixed / report.violation.length : 0;
    const asserted = report.violation.filter((r) => r.how === 'assert');
    report.assertCount = asserted.length;
    report.assertRecall = asserted.length
      ? asserted.filter((r) => r.verdict === 'fixed').length / asserted.length
      : 0;
  }

  if (sets.includes('conformance')) {
    const fixtures = await loadFixtures(join(opts.fixtureDir, 'conforming.txt'));
    report.conformance = await pool(fixtures, CONCURRENCY, async (f) => {
      const revision = await revise(opts.call, opts.models.revise, system, f.body);
      return {
        id     : f.id,
        verdict: revision === f.body ? ('unchanged' as const) : ('churned' as const),
        how    : 'compare' as const,
        revision,
      };
    });
    const churned = report.conformance.filter((r) => r.verdict === 'churned').length;
    report.churn = report.conformance.length ? churned / report.conformance.length : 0;
  }

  if (sets.includes('context')) {
    const fixtures = await loadFixtures(join(opts.fixtureDir, 'context.txt'));
    report.context = await pool(fixtures, CONCURRENCY, async (f) => ({
      id      : f.id,
      verdict : 'revised' as const,
      how     : 'compare' as const,
      revision: await revise(opts.call, opts.models.revise, system, f.body),
    }));
  }

  return report;
}
