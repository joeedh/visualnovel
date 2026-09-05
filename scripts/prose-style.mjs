/**
 * The prose-style tool of [`docs/plans/enforcing-prose-style-without-context-poisoning.md`]:
 * revises one document a block at a time, and measures itself against fixtures.
 *
 * Everything that decides anything is in `scripts/prosestyle/`, which has tests. What is here is
 * the network, the key and the files.
 *
 * The revision prompt is never given a whole document, and the results file holds the revisions
 * so that no model-written prose is printed to the caller's terminal. Both properties are the
 * point of the plan rather than housekeeping.
 *
 * Usage:
 *   node scripts/prose-style.mjs --file docs/guides/testkit.md
 *   node scripts/prose-style.mjs --fixtures [--set violation]
 *   node scripts/prose-style.mjs --audit-judge
 *   node scripts/prose-style.mjs --file <path> --revise-model openrouter/z-ai/glm-5.3-flash
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, join, relative as relative_, resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';

/** Written where `@anthropic-ai/sdk` resolves; pnpm's layout does not hoist it to the root. */
const SDK_HOST = join(root, 'apps/desktop');
const TMP = resolve(SDK_HOST, '.prosestyle-entry.cjs');

const RULES = join(root, 'docs/reference/proseStyle.md');
const FIXTURES = join(root, 'scripts/prosestyle/fixtures');
const OUT_DIR = join(root, '.prosestyle');

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const auditOnly = process.argv.includes('--audit-judge');
const target = flag('file');
if (!process.argv.includes('--fixtures') && !auditOnly && !target) {
  console.error('nothing to do: pass --file <path>, --fixtures, or --audit-judge');
  process.exit(2);
}

const reviseModel = flag('revise-model', 'anthropic/claude-opus-5');
const judgeModel = flag('judge-model', 'anthropic/claude-sonnet-5');
const checkModel = flag('check-model', 'anthropic/claude-sonnet-5');
const only = flag('set');

await build({
  stdin: {
    contents: [
      "export { runFixtures, auditJudge, runFile, checkFacts } from './scripts/prosestyle/main.js';",
      "export { allowsRewrite } from './scripts/prosestyle/allow.js';",
      "export { parseModelRef, baseUrlFor } from './scripts/prosestyle/model.js';",
      "export { findKey } from './scripts/prosestyle/keys.js';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: TMP,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
});

const require = createRequire(join(SDK_HOST, 'package.json'));
const {
  runFixtures,
  auditJudge,
  runFile,
  checkFacts,
  allowsRewrite,
  parseModelRef,
  baseUrlFor,
  findKey,
} = require(TMP);
const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');

const keyDirs = [join(root, 'keys')];
const clients = new Map();

/** One client per route, built on first use so an unused route needs no key. */
async function clientFor(route) {
  const existing = clients.get(route);
  if (existing) return existing;
  const { value, source } = await findKey(route, keyDirs);
  const where = source.kind === 'env' ? `$${source.name}` : source.path;
  console.log(`${route}: key from ${where}`);
  const baseURL = baseUrlFor(route);
  const client = new Anthropic({ apiKey: value, ...(baseURL ? { baseURL } : {}) });
  clients.set(route, client);
  return client;
}

const call = async ({ model, system, user, maxTokens }) => {
  const ref = parseModelRef(model);
  const client = await clientFor(ref.route);
  const res = await client.messages.create({
    model: ref.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
};

/**
 * The whole run. It returns rather than calling `process.exit`, so the temporary bundle is
 * always removed: an exit inside the `try` skips the `finally`, and the file it leaves behind is
 * linted by eslint, whose flat config reads no `.gitignore`.
 */
async function run() {
  if (auditOnly) {
    const audit = await auditJudge({ call, model: judgeModel, fixtureDir: FIXTURES });
    console.log(`\njudge ${judgeModel}`);
    console.log(
      `  finds the violation in unrevised text: ${(audit.sensitivity * 100).toFixed(0)}%`,
    );
    console.log(
      `  reports one in conforming text:        ${(audit.falsePositive * 100).toFixed(0)}%`,
    );
    for (const m of audit.missed) console.log(`  MISSED   ${m.id.padEnd(16)} ${m.rule}`);
    for (const f of audit.flagged) console.log(`  FALSE    ${f.id.padEnd(16)} ${f.rule}`);
    return;
  }

  if (target) {
    const absolute = resolve(root, target);
    const relative = relative_(root, absolute);
    const allowance = allowsRewrite(relative);
    if (!allowance.allowed) {
      console.error(`refused: ${allowance.why}`);
      process.exitCode = 2;
      return;
    }

    const source = await fs.readFile(absolute, 'utf8');
    const result = await runFile({ call, model: reviseModel, rulesPath: RULES, source });

    await fs.mkdir(OUT_DIR, { recursive: true });
    const name = basename(absolute, '.md');
    const revisedPath = join(OUT_DIR, `${name}.revised.md`);
    const diffPath = join(OUT_DIR, `${name}.diff`);
    await fs.writeFile(revisedPath, result.revised, 'utf8');

    // `git diff --no-index` exits 1 when the files differ, which is the expected case here.
    const diff = spawnSync(
      'git',
      ['diff', '--no-index', '--no-color', '--', absolute, revisedPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    await fs.writeFile(diffPath, diff.stdout ?? '', 'utf8');

    console.log(`\n${relative}`);
    console.log(`  ${result.blocks} blocks, ${result.prose} prose, ${result.changed} changed`);

    let findings = [];
    if (!process.argv.includes('--no-check-facts') && result.changes.length) {
      findings = await checkFacts({ call, model: checkModel, changes: result.changes });
      const count = (verdict) => findings.filter((f) => f.verdict === verdict).length;
      console.log(
        `  facts: ${count('equivalent')} equivalent, ${count('drifted')} drifted,` +
          ` ${count('unverifiable')} unverifiable`,
      );
      for (const f of findings.filter((x) => x.verdict !== 'equivalent')) {
        console.log(`    block ${f.at} ${f.verdict}${f.span ? ` at ${f.span.start}` : ''}`);
      }
    }

    await fs.writeFile(
      join(OUT_DIR, `${name}.facts.json`),
      JSON.stringify({ reviseModel, checkModel, findings }, undefined, 2),
      'utf8',
    );
    console.log(`  revised: ${revisedPath}`);
    console.log(`  diff:    ${diffPath}`);
    return;
  }

  const report = await runFixtures({
    call,
    models: { revise: reviseModel, judge: judgeModel },
    rulesPath: RULES,
    fixtureDir: FIXTURES,
    ...(only ? { sets: [only] } : {}),
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(OUT_DIR, `fixtures-${stamp}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify({ reviseModel, judgeModel, ...report }, undefined, 2),
    'utf8',
  );

  if (report.violation.length) {
    console.log(
      `\nviolation set — asserted ${(report.assertRecall * 100).toFixed(0)}%` +
        ` of ${report.assertCount}; all-in ${(report.recall * 100).toFixed(0)}%` +
        ` (read --audit-judge for what the judged rows are worth)`,
    );
    for (const r of report.violation) {
      const mark = r.verdict === 'fixed' ? 'fixed   ' : 'SURVIVED';
      console.log(`  ${mark} ${r.id.padEnd(16)} ${r.rule} (${r.how})`);
    }
  }
  if (report.conformance.length) {
    console.log(`\nconformance set — churn ${(report.churn * 100).toFixed(0)}%`);
    for (const r of report.conformance) {
      console.log(`  ${r.verdict.padEnd(9)} ${r.id}`);
    }
  }
  if (report.context.length) {
    console.log(`\ncontext set — ${report.context.length} revised, read them in the results file`);
  }
  console.log(`\nresults: ${outPath}`);
}

try {
  await run();
} finally {
  await fs.rm(TMP, { force: true });
}
