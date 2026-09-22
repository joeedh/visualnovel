/**
 * The live half of [`docs/plans/merging-a-conflicted-file.md`]: a real model merges real
 * collisions through the real agent loop, and writes a transcript per case for a person to read.
 *
 * Advisory and key-needing, like `scripts/audit-key-instructions.mjs`. It never runs in CI, it
 * writes nothing into the repository, and it exits 0 unless it could not run at all.
 *
 * Usage:
 *   node scripts/merge-eval.mjs [--model <id>] [--answer <id>] [--interactive]
 *                               [--case <name>] [--out <dir>] [--keep]
 *   node scripts/merge-eval.mjs --dry-run    # build the fixture, ask nothing
 *
 * The fixture is built fresh under the out directory: the sample project's inputs, a bare shared
 * copy, and one pair of clones per case, whose two authors collide on one file. The model under
 * test answers the opener `agent.mergeConflict` seeds, in plan mode, so it proposes, may ask, and
 * needs approval before it writes. The answerer plays the author: with `--interactive` a person at
 * the terminal, otherwise a second model given only that case's brief.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const SAMPLE = resolve(root, '../visualnovel/examples/mySampleRepo');
const TMP = resolve(root, 'apps/desktop/.mergeeval-entry.cjs');

/** What the fixture carries: inputs and storyboards, never assets, never keys. */
const COPIED = ['project.yaml', 'characters', 'locations', 'scenes', 'wiki'];

/** How many exchanges one case may take before it counts as a failure. */
const MAX_TURNS = 6;

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const stamp = () => new Date().toISOString().slice(0, 10);
const outRoot = resolve(flag('out', join(tmpdir(), 'vn-merge-eval', stamp())));
const model = flag('model', 'claude-sonnet-5');
const answerModel = flag('answer', 'claude-sonnet-5');
const interactive = process.argv.includes('--interactive');
const dryRun = process.argv.includes('--dry-run');
const only = flag('case', undefined);

// ─────────────────────────────────────────────────────────────────── the cases

const ARRIVAL_L3 = 'She bows, a little too deeply.';

const shots = (name) => `vngen/work/shots/${name}.json`;

const edit = async (dir, path, from, to) => {
  const at = join(dir, path);
  const text = await fs.readFile(at, 'utf8');
  if (!text.includes(from)) throw new Error(`${path}: fixture text not found: ${from}`);
  await fs.writeFile(at, text.replace(from, to), 'utf8');
};

const CASES = [
  {
    name : 'prose',
    path : 'scenes/arrival.md',
    their: {
      message: 'Aiko: hold the bow a beat',
      apply: (dir) =>
        edit(
          dir,
          'scenes/arrival.md',
          ARRIVAL_L3,
          'She bows, far too deeply, and the room goes very quiet.',
        ),
    },
    mine: {
      message: 'Aiko curtsies, and the third row laughs',
      apply: async (dir) => {
        await edit(
          dir,
          'scenes/arrival.md',
          ARRIVAL_L3,
          'She curtsies, a little too deeply.\n\n[[line: L6]]\nSomeone in the third row stifles a laugh.',
        );
        await edit(dir, 'scenes/arrival.md', '[[nextline: 6]]', '[[nextline: 7]]');
      },
    },
    brief:
      'I changed L3 because Aiko was raised in Vienna — she curtsies, she never bows, and the ' +
      'rest of the story depends on that. I also added L6, the line about the third row ' +
      'stifling a laugh. My collaborator was after something else: they wanted the room to go ' +
      'quiet after it. I want all three things in the scene.',
    check: (text) => (text.includes('[[line: L6]]') ? undefined : 'the inserted line L6 is gone'),
  },
  {
    name : 'shots-fields',
    path : shots('greet'),
    their: {
      message: 'greet: closer on the introduction',
      apply  : (dir) => edit(dir, shots('greet'), '"framing": "medium"', '"framing": "close"'),
    },
    mine: {
      message: 'greet: the afternoon light',
      apply: async (dir) => {
        const at = join(dir, shots('greet'));
        const text = await fs.readFile(at, 'utf8');
        const beat = text.indexOf('"id": "greet__beat1"');
        const day = text.indexOf('"location": "day"', beat);
        await fs.writeFile(
          at,
          `${text.slice(0, day)}"location": "afternoon"${text.slice(day + '"location": "day"'.length)}`,
          'utf8',
        );
      },
    },
    brief:
      'I moved the second shot of greet to the afternoon variant, because the scene is after ' +
      'lunch. My collaborator tightened the framing on the same shot. Those are two different ' +
      'things and I want both.',
    check: (text) => {
      const board = JSON.parse(text);
      const beat = board.shots.find((s) => s.id === 'greet__beat1');
      if (beat?.framing !== 'close') return 'their framing was dropped';
      if (beat?.location !== 'afternoon') return 'my location was dropped';
      return undefined;
    },
  },
  {
    name  : 'shots-same-field',
    path  : shots('observe'),
    their: {
      message: 'observe: medium on the window seat',
      apply  : (dir) => edit(dir, shots('observe'), '"framing": "wide"', '"framing": "medium"'),
    },
    mine: {
      message: 'observe: close on the window seat',
      apply  : (dir) => edit(dir, shots('observe'), '"framing": "wide"', '"framing": "close"'),
    },
    brief:
      'We both reframed the one shot of observe, and I have not decided which I want. My notes ' +
      'do not say.',
    // Revealed only when the model asks rather than guessing.
    secret:
      'If you are asked which framing to keep: theirs, the medium. The scene before it is ' +
      'already an establishing shot, so a close would be two tight frames in a row.',
    check: (text) => {
      const framing = JSON.parse(text).shots.find((s) => s.id === 'observe__S1')?.framing;
      return framing === 'medium' ? undefined : `kept ${framing ?? 'nothing'}, not the medium`;
    },
  },
  {
    name : 'shots-add-next',
    path : shots('ending'),
    their: {
      message: 'ending: a shot of the empty corridor',
      apply  : (dir) => addShot(dir, 'ending', 'the empty corridor through the door'),
    },
    mine: {
      message: 'ending: a shot of the desk she leaves',
      apply  : (dir) => addShot(dir, 'ending', 'her desk, chair pushed in, in the last light'),
    },
    brief:
      'We each added a shot to the end of ending, and the app gave both of them the same id ' +
      'because neither of us had the other’s save yet. They are different moments and I want ' +
      'both of them, in either order.',
    check: (text) => {
      const board = JSON.parse(text);
      const ids = board.shots.map((s) => s.id);
      if (new Set(ids).size !== ids.length) return `duplicate shot id in ${ids.join(', ')}`;
      if (ids.length < 3) return `only ${ids.length} shots; one of the two was dropped`;
      const spent = ids
        .map((id) => /__shot(\d+)$/.exec(id))
        .filter(Boolean)
        .map((m) => Number(m[1]));
      const mark = board.nextShot;
      if (typeof mark !== 'number') return 'nextShot is gone';
      return spent.every((n) => mark > n) ? undefined : `nextShot ${mark} is not past ${spent}`;
    },
  },
];

/** Append one shot with the id `nextShot` would mint, and spend the mark, as the app does. */
async function addShot(dir, scene, camera) {
  const at = join(dir, shots(scene));
  const board = JSON.parse(await fs.readFile(at, 'utf8'));
  const n = board.nextShot;
  board.shots.push({
    id      : `${scene}__shot${n}`,
    sceneId : scene,
    framing : 'wide',
    location: 'evening',
    subjects: [],
    camera,
    coversLines: [],
  });
  board.nextShot = n + 1;
  await fs.writeFile(at, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────── git

function git(dir, args) {
  return new Promise((done, fail) => {
    const child = spawn('git', args, { cwd: dir, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out, err }));
  });
}

async function gitOk(dir, args) {
  const r = await git(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

async function identify(dir, name, email) {
  await gitOk(dir, ['config', 'user.name', name]);
  await gitOk(dir, ['config', 'user.email', email]);
  await gitOk(dir, ['config', 'core.autocrlf', 'false']);
}

/** The inputs of the sample project, one commit, and a bare copy for the clones to share. */
async function buildBase() {
  const base = join(outRoot, 'fixture', 'base');
  await fs.rm(join(outRoot, 'fixture'), { recursive: true, force: true });
  await fs.mkdir(base, { recursive: true });
  for (const entry of COPIED) {
    await fs.cp(join(SAMPLE, entry), join(base, entry), { recursive: true });
  }
  await fs.mkdir(join(base, 'vngen', 'work', 'shots'), { recursive: true });
  for (const scene of ['greet', 'observe', 'ending']) {
    const board = JSON.parse(await fs.readFile(join(SAMPLE, shots(scene)), 'utf8'));
    // A storyboard the app has written since the id mark landed carries one; these predate it
    board.nextShot ??= 2;
    await fs.writeFile(join(base, shots(scene)), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  }
  await fs.writeFile(join(base, '.gitignore'), 'keys/\n.vnstudio/\n', 'utf8');
  await gitOk(base, ['init', '-q', '-b', 'main']);
  await identify(base, 'Fixture', 'fixture@example.com');
  await gitOk(base, ['add', '-A']);
  await gitOk(base, ['commit', '-q', '-m', 'Fixture inputs']);
  const shared = join(outRoot, 'fixture', 'shared.git');
  await gitOk(join(outRoot, 'fixture'), ['clone', '-q', '--bare', base, shared]);
  return shared;
}

/**
 * One case's pair of clones: the collaborator saves and sends first, the author saves and gets
 * their saves, which stops the rebase on the one file both of them changed.
 */
async function collide(shared, testCase) {
  const dir = join(outRoot, 'fixture', testCase.name);
  const theirs = join(dir, 'theirs');
  const mine = join(dir, 'mine');
  // `-c core.autocrlf=false` on the clone itself: set afterwards, the checkout has already
  // happened, and the file the model reads would differ from the one it writes by its line endings
  await gitOk(outRoot, ['clone', '-q', '-c', 'core.autocrlf=false', shared, theirs]);
  await gitOk(outRoot, ['clone', '-q', '-c', 'core.autocrlf=false', shared, mine]);
  await identify(theirs, 'Theo', 'theo@example.com');
  await identify(mine, 'Mara', 'mara@example.com');

  await testCase.their.apply(theirs);
  await gitOk(theirs, ['commit', '-qam', testCase.their.message]);
  await gitOk(theirs, ['push', '-q', 'origin', 'HEAD:main']);

  await testCase.mine.apply(mine);
  await gitOk(mine, ['commit', '-qam', testCase.mine.message]);
  await gitOk(mine, ['fetch', '-q', 'origin']);
  const rebase = await git(mine, ['rebase', 'origin/main']);
  if (rebase.code === 0) throw new Error(`${testCase.name}: the rebase did not stop on a conflict`);
  const unmerged = await gitOk(mine, ['diff', '--name-only', '--diff-filter=U']);
  const paths = unmerged.split('\n').filter(Boolean);
  if (paths.join() !== testCase.path) {
    throw new Error(`${testCase.name}: expected ${testCase.path} in question, got ${paths}`);
  }
  // `git show` converts line endings on the way out; the diff is against what the model wrote
  const side = async (stage) =>
    (await git(mine, ['show', `${stage}:${testCase.path}`])).out.replace(/\r\n/g, '\n');
  return { dir: mine, theirSide: await side(':2'), mySide: await side(':3') };
}

// ────────────────────────────────────────────────────────────────── the model

await build({
  stdin: {
    contents: [
      "export { createAuthoringAgent } from './apps/authoring/src/agent.js';",
      "export { mergeOpener } from './apps/desktop/src/shared/agentseed.js';",
      "export { resolutionProblem } from '@vn/model';",
      "export { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';",
      "export { chatBackendFor } from '@vn/providers';",
      "export { chatRouteFor } from '@vn/types';",
      "export { unifiedDiff } from '@vn/util';",
    ].join('\n'),
    resolveDir: root,
    loader    : 'ts',
  },
  outfile : TMP,
  bundle  : true,
  platform: 'node',
  format  : 'cjs',
  target  : 'node20',
  alias,
  external: EXTERNAL,
  logLevel: 'warning',
});

const {
  chatBackendFor,
  chatRouteFor,
  createAuthoringAgent,
  loadConfig,
  mergeOpener,
  resolutionProblem,
  resolveKeys,
  secretDirsFor,
  unifiedDiff,
} = createRequire(import.meta.url)(TMP);
await fs.rm(TMP, { force: true });

/** The answerer's backend, resolved the way the app resolves a key: env var, then `keys/`. */
async function answerBackend(dir) {
  const config = await loadConfig(dir);
  const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(dir) });
  const present = {
    anthropic : Boolean(keys.anthropic),
    gemini    : Boolean(keys.gemini),
    openrouter: Boolean(keys.openrouter),
  };
  const route = chatRouteFor(answerModel, present);
  if (!route) throw new Error(`no key carries ${answerModel}; set its vendor’s variable`);
  return chatBackendFor(route, keys).backend;
}

const ANSWERER_SYSTEM = [
  'You are the author of a visual novel project, talking to your own writing assistant while it',
  'merges a file two of you changed at once. You know only what your notes below say.',
  '',
  'Answer in the first person, in one or two sentences, as the author would in a chat box.',
  'Never write file contents, code, or markers. Never do the merge yourself.',
  'Begin your reply with APPROVE: when the assistant has proposed a plan that does what your',
  'notes want, or CHANGES: when it does not, or ANSWER: when it asked you something. After the',
  'word, say it in your own words.',
].join('\n');

/** The author's reply to the assistant's latest message: a person, or the answerer model. */
async function answerer(dir, testCase) {
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      async reply(text) {
        console.log(`\n--- the assistant says ---\n${text}\n`);
        const said = await rl.question('you (the author) > ');
        return { text: said, usage: undefined };
      },
      close: () => rl.close(),
    };
  }
  const backend = await answerBackend(dir);
  const notes = [testCase.brief, testCase.secret].filter(Boolean).join('\n\n');
  return {
    async reply(text) {
      const prompt = [
        `Your notes on ${testCase.path}:`,
        notes,
        '',
        'The assistant says:',
        text,
      ].join('\n');
      const req = { system: ANSWERER_SYSTEM, prompt };
      const answer = backend.messageWithUsage
        ? await backend.messageWithUsage(req)
        : { text: await backend.message(req) };
      return { text: answer.text.trim(), usage: answer.usage };
    },
    close: () => {},
  };
}

// ──────────────────────────────────────────────────────────────────── one case

/** Run one case end to end: the fixture, the conversation, the checks, the transcript. */
async function runCase(shared, testCase) {
  const { dir, theirSide, mySide } = await collide(shared, testCase);
  const config = await fs.readFile(join(dir, 'project.yaml'), 'utf8');
  await fs.writeFile(
    join(dir, 'project.yaml'),
    config.replace(/^(\s*text:).*$/m, `$1 ${model}`),
    'utf8',
  );

  const lines = [];
  const say = (text) => lines.push(text);
  const events = [];
  const author = await answerer(dir, testCase);
  let answered = 0;
  let asked = false;

  const permission = {
    async approvePlan(plan) {
      const rendered = [
        `Plan: ${plan.summary}`,
        ...plan.steps.map((s) => `- ${s}`),
        `Files: ${plan.files.join(', ')}`,
      ].join('\n');
      const said = await author.reply(rendered);
      answered += 1;
      say(`\n**The author, on the plan:** ${said.text}`);
      const approved = /^\s*APPROVE\b/i.test(said.text);
      return approved ? { approved: true } : { approved: false, feedback: said.text };
    },
    confirmAction() {
      return Promise.resolve(false);
    },
    async ask(form) {
      asked = true;
      const said = await author.reply(form.map((q) => q.question).join('\n'));
      answered += 1;
      say(`\n**The author, asked:** ${said.text}`);
      return form.map(() => said.text);
    },
  };

  const { agent } = await createAuthoringAgent(dir, permission, {
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'tool' && event.tool === 'ask_user') asked = true;
    },
  });

  const seed = mergeOpener(testCase.path, testCase.mine.message);
  say(`# ${testCase.name} — ${testCase.path}`);
  say(
    `\nModel under test: \`${model}\`. Answering: ${interactive ? 'a person' : `\`${answerModel}\``}.`,
  );
  say(`\n**The opener:** ${seed}`);

  let turn = 0;
  let wrote = false;
  let next = seed;
  while (turn < MAX_TURNS && !wrote) {
    turn += 1;
    const before = events.length;
    const result = await agent.run(next);
    for (const event of events.slice(before)) {
      if (event.type === 'tool') {
        say(`\n**${event.tool}** ${clip(JSON.stringify(event.args))}`);
        say(`\n> ${clip(event.result.output).split('\n').join('\n> ')}`);
        if (event.tool === 'resolve_conflict' && event.result.ok) wrote = true;
      } else if (event.type === 'blocked') {
        say(`\n**blocked: ${event.tool}** — ${event.reason}`);
      } else if (event.type === 'message') {
        say(`\n**The assistant:** ${event.text}`);
      }
    }
    say(`\n**The assistant ends turn ${turn}:** ${result.final}`);
    if (wrote) break;
    const said = await author.reply(result.final);
    answered += 1;
    say(`\n**The author:** ${said.text}`);
    next = said.text;
  }
  author.close();

  // The checks, over what is on disk now — the same text the author would see in the pane
  const merged = await fs.readFile(join(dir, testCase.path), 'utf8').catch(() => null);
  const problems = [];
  if (!wrote) problems.push(`resolve_conflict was never called (${turn} exchanges)`);
  if (merged === null) problems.push('the file is gone');
  if (merged !== null) {
    if (/^(<{7}|={7}|>{7})( |$)/m.test(merged)) problems.push('markers are still in the file');
    const problem = resolutionProblem(testCase.path, merged);
    if (problem) problems.push(problem);
    else {
      try {
        const own = testCase.check(merged);
        if (own) problems.push(own);
      } catch (err) {
        problems.push(`the check could not read it: ${err.message}`);
      }
    }
  }

  const usage = events
    .filter((e) => e.type === 'usage')
    .reduce((sum, e) => ({ input: sum.input + e.input, output: sum.output + e.output }), {
      input : 0,
      output: 0,
    });

  say('\n## What the checks say\n');
  say(problems.length === 0 ? 'Every check passed.' : problems.map((p) => `- ${p}`).join('\n'));
  if (merged !== null) {
    say('\n## The merge against their side\n');
    say(`\`\`\`diff\n${unifiedDiff(theirSide, merged)}\n\`\`\``);
    say('\n## The merge against my side\n');
    say(`\`\`\`diff\n${unifiedDiff(mySide, merged)}\n\`\`\``);
  }

  const transcript = join(outRoot, `${testCase.name}.md`);
  await fs.writeFile(transcript, `${lines.join('\n')}\n`, 'utf8');
  return { name: testCase.name, problems, turns: turn, answered, asked, usage, transcript };
}

const lineCount = (text) => text.split(/\r?\n/).length;

const clip = (text, max = 600) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;

// ────────────────────────────────────────────────────────────────────── run it

await fs.mkdir(outRoot, { recursive: true });
const shared = await buildBase();
const chosen = CASES.filter((c) => !only || c.name === only);
if (chosen.length === 0) throw new Error(`no case named ${only}`);

if (dryRun) {
  for (const testCase of chosen) {
    const { theirSide, mySide } = await collide(shared, testCase);
    console.log(
      `[merge-eval] ${testCase.name}: ${testCase.path} is in question — ` +
        `${lineCount(theirSide)} lines theirs, ${lineCount(mySide)} lines mine`,
    );
  }
  console.log(`[merge-eval] the fixture is at ${join(outRoot, 'fixture')}; nothing was asked`);
  process.exit(0);
}

const results = [];
for (const testCase of chosen) {
  console.log(`[merge-eval] ${testCase.name} — ${testCase.path}`);
  try {
    const result = await runCase(shared, testCase);
    results.push(result);
    console.log(
      `[merge-eval] ${result.problems.length === 0 ? 'pass' : 'FAIL'} ` +
        `${result.turns} exchange(s), ${result.asked ? 'asked' : 'did not ask'}, ` +
        `${result.usage.input}/${result.usage.output} tokens — ${result.transcript}`,
    );
    for (const problem of result.problems) console.log(`    ${problem}`);
  } catch (err) {
    console.log(`[merge-eval] ${testCase.name} could not run: ${err.message}`);
    results.push({ name: testCase.name, problems: [err.message], turns: 0, answered: 0 });
  }
}

const summary = [
  `# Merge eval — ${stamp()}`,
  '',
  `Model under test: \`${model}\`. Answering: ${interactive ? 'a person' : `\`${answerModel}\``}.`,
  '',
  '| case | checks | exchanges | asked | tokens in/out |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.problems?.length ? r.problems.join('; ') : 'pass'} | ${r.turns} | ` +
      `${r.asked ? 'yes' : 'no'} | ${r.usage?.input ?? 0}/${r.usage?.output ?? 0} |`,
  ),
].join('\n');
await fs.writeFile(join(outRoot, 'summary.md'), `${summary}\n`, 'utf8');
console.log(`\n${summary}\n`);
if (!process.argv.includes('--keep')) {
  await fs.rm(join(outRoot, 'fixture'), { recursive: true, force: true });
}
